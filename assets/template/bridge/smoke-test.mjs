// 冒烟测试（全程 dry-run，不连网、不用真实凭证）：
// 起一个临时运行目录 + 子进程 daemon，喂 3 条脚本入站消息，验证：
//   1. 主人私聊消息落 queue/inbound
//   2. 陌生人消息被记 queue/strangers.jsonl 且不入队
//   3. 主人群聊 @ 消息落 queue/inbound（scope=group）
//   4. 回复经假传输发出且挂对 msgId（被动回复）
//   5. 同一 msgId 第 5 条回复降级为主动消息（被动上限 4）
//   6. 出站文件处理后移入 queue/sent
//   7. chunker 把 1 万字 markdown 切成 ≤4500 的块且代码围栏不拆
// 每条断言打印 PASS/FAIL，任一 FAIL 退出码非 0。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkMarkdown } from './chunker.mjs';

const bridgeDir = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
  if (!cond) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 20000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(step);
  }
  return fn();
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-smoke-'));
console.log(`smoke root: ${tmp}`);
for (const d of ['config', 'queue/inbound', 'queue/outbound', 'queue/sent', 'queue/failed', 'queue/processed', 'state', 'logs']) {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
}
fs.writeFileSync(path.join(tmp, 'config', 'credentials.json'), JSON.stringify({
  appId: 'smoke-app', appSecret: 'smoke-secret', ownerOpenId: 'OWNER_OPENID', allowedOpenIds: [],
}), { mode: 0o600 });
fs.writeFileSync(path.join(tmp, 'config', 'config.json'), JSON.stringify({
  mergeWindowMs: 300, outboundPollMs: 200, heartbeatMs: 1000,
}));

const OWNER = 'OWNER_OPENID';
const scripted = [
  { kind: 'c2c', senderId: OWNER, senderName: 'owner', content: '你好，这是主人私聊', messageId: 'm1' },
  { kind: 'c2c', senderId: 'STRANGER_OPENID', senderName: 'stranger', content: '陌生人消息', messageId: 'm2' },
  { kind: 'group', senderId: OWNER, senderName: 'owner', content: '群里的问题', messageId: 'm3', groupOpenid: 'GROUP_OPENID' },
];
const inboundFile = path.join(tmp, 'scripted-inbound.json');
const sentFile = path.join(tmp, 'dry-sent.jsonl');
fs.writeFileSync(inboundFile, JSON.stringify(scripted));

const child = spawn(process.execPath, [path.join(bridgeDir, 'qq-daemon.mjs'), '--dry-run'], {
  env: {
    ...process.env,
    QQ_BRIDGE_ROOT: tmp,
    QQ_BRIDGE_DRY_RUN: '1',
    QQ_BRIDGE_SMOKE_INBOUND: inboundFile,
    QQ_BRIDGE_SMOKE_SENT: sentFile,
    QQ_BRIDGE_SMOKE_DELAY_MS: '30',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });

const readSent = () => (fs.existsSync(sentFile)
  ? fs.readFileSync(sentFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);
const inboundFiles = () => fs.readdirSync(path.join(tmp, 'queue', 'inbound')).filter((f) => f.endsWith('.json'));
const readInbound = () => inboundFiles().map((f) => JSON.parse(fs.readFileSync(path.join(tmp, 'queue', 'inbound', f), 'utf8')));

try {
  const gotInbound = await waitFor(() => inboundFiles().length >= 2);
  check('owner c2c + group messages queued', gotInbound, `inbound files=${inboundFiles().length}`);
  const msgs = readInbound();
  check('owner c2c message in inbound', msgs.some((m) => m.scope === 'c2c' && m.text.includes('主人私聊')));
  check('owner group message in inbound', msgs.some((m) => m.scope === 'group' && m.target_id === 'GROUP_OPENID' && m.text.includes('群里的问题')));

  const strangersRaw = fs.existsSync(path.join(tmp, 'queue', 'strangers.jsonl'))
    ? fs.readFileSync(path.join(tmp, 'queue', 'strangers.jsonl'), 'utf8') : '';
  check('stranger recorded in strangers.jsonl', strangersRaw.includes('STRANGER_OPENID'));
  check('stranger NOT in inbound', !msgs.some((m) => (m.text || '').includes('陌生人消息')));

  const writeJob = (name, job) => fs.writeFileSync(path.join(tmp, 'queue', 'outbound', name), JSON.stringify(job));
  writeJob('job1.json', { scope: 'c2c', targetId: OWNER, text: 'reply-1', replyToMsgId: 'm1' });
  const got1 = await waitFor(() => readSent().some((s) => s.content === 'reply-1'));
  check('reply-1 sent by fake transport', got1);
  const s1 = readSent().find((s) => s.content === 'reply-1');
  check('reply-1 is passive (msgId=m1)', s1?.target?.msgId === 'm1', `msgId=${s1?.target?.msgId}`);

  for (let i = 2; i <= 5; i++) {
    writeJob(`job${i}.json`, { scope: 'c2c', targetId: OWNER, text: `reply-${i}`, replyToMsgId: 'm1' });
  }
  const gotAll = await waitFor(() => [2, 3, 4, 5].every((i) => readSent().some((s) => s.content === `reply-${i}`)));
  check('reply-2..5 all sent', gotAll);
  const passiveOnM1 = readSent().filter((s) => s.target?.msgId === 'm1').length;
  check('passive replies on m1 capped at 4', passiveOnM1 === 4, `passive=${passiveOnM1}`);
  const s5 = readSent().find((s) => s.content === 'reply-5');
  check('5th reply degraded to proactive (no msgId)', gotAll && s5 && !s5.target?.msgId);

  const sentDirFiles = fs.readdirSync(path.join(tmp, 'queue', 'sent')).filter((f) => f.endsWith('.json'));
  check('processed outbound files moved to queue/sent', sentDirFiles.length >= 5, `sent=${sentDirFiles.length}`);

  // chunker
  let big = '';
  for (let i = 0; i < 30; i++) big += `段落 ${i} ` + 'x'.repeat(200) + '\n\n';
  big += '```js\n' + 'console.log("hello");\n'.repeat(20) + '```\n\n';
  big += '尾巴段落 ' + 'y'.repeat(4200);
  const chunks = chunkMarkdown(big, 4500);
  check('chunker splits 10k markdown into multiple chunks', big.length > 10000 && chunks.length > 1, `len=${big.length} chunks=${chunks.length}`);
  check('every chunk <= 4500 chars', chunks.every((c) => c.length <= 4500), `max=${Math.max(...chunks.map((c) => c.length))}`);
  const fenceChunk = chunks.find((c) => c.includes('```js'));
  check('code fence block kept intact in one chunk',
    Boolean(fenceChunk) && (fenceChunk.match(/console\.log/g) || []).length === 20 && fenceChunk.includes('\n```'));
} finally {
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((r) => child.on('exit', (code, signal) => r({ code, signal }))),
    sleep(5000).then(() => null),
  ]);
  if (!exited) { child.kill('SIGKILL'); }
  check('daemon exits on SIGTERM', Boolean(exited), exited ? `code=${exited.code} signal=${exited.signal}` : 'timeout');
  if (failures > 0) {
    console.log('--- daemon log tail ---');
    console.log(childLog.split('\n').slice(-25).join('\n'));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? 'SMOKE RESULT: ALL PASS' : `SMOKE RESULT: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
