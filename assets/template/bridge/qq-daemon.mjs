// muse-qq-bridge daemon：QQ 机器人长连接 <-> 本地文件队列。
//
// 入站：SDK WebSocket 消息 -> 白名单（默认拒绝）-> 同 peer 连发合并
//      -> queue/inbound/*.json（原子写）-> Muse hook 唤醒 Agent 处理。
// 出站：Agent 把回复写进 queue/outbound/*.json -> 本进程按被动回复规则
//      （同一 msgId 最多 4 次、窗口内有效；耗尽/过期降级主动消息）
//      经 SDK sendMarkdown 发出 -> 文件移入 queue/sent 或 queue/failed。
// 陌生人（不在白名单）：只记 queue/strangers.jsonl，永不自动放行、永不回复。
//
// 用法：node bridge/qq-daemon.mjs [--dry-run]
//   --dry-run / QQ_BRIDGE_DRY_RUN=1：不连网，用脚本文件喂入站、记录出站（冒烟测试用）。
// 凭证：config/credentials.json（0600），只经 bridge/bind.mjs 写入，本文件只读。

import fs from 'node:fs';
import path from 'node:path';
import {
  resolveRoot, paths, ensureDirs, readJsonSafe, atomicWriteJson, appendJsonl,
  nowIso, makeLogger, loadConfig, loadCredentials, peerKey,
} from './lib.mjs';
import { chunkMarkdown } from './chunker.mjs';
import { createRealTransport, createDryRunTransport } from './transport.mjs';

const DRY_RUN = process.argv.includes('--dry-run') || process.env.QQ_BRIDGE_DRY_RUN === '1';

const root = resolveRoot();
const P = paths(root);
ensureDirs(P);
const logger = makeLogger(P.daemonLog);
const config = loadConfig(P);
const credentials = loadCredentials(P);

if (!credentials || !credentials.appId || !credentials.appSecret) {
  if (!DRY_RUN) {
    logger.error('credentials missing: run `node bridge/bind.mjs` first (config/credentials.json)');
    process.exit(2);
  }
  logger.warn('dry-run without credentials.json: using placeholder credentials');
}
const creds = credentials || { appId: 'dry', appSecret: 'dry', ownerOpenId: '', allowedOpenIds: [] };
const allowed = new Set([creds.ownerOpenId, ...creds.allowedOpenIds].filter(Boolean));

// ---------- 持久状态：去重、msgId 缓存与被动回复计数 ----------
const seen = new Set(readJsonSafe(P.seenFile, []) || []);
function persistSeen() {
  atomicWriteJson(P.seenFile, [...seen].slice(-5000));
}
const cache = readJsonSafe(P.msgidCacheFile, null) || { peers: {}, msgTs: {}, counts: {} };
function persistCache() {
  // 清理 2 小时前的计数记录，避免无限增长
  const cutoff = Date.now() - 2 * 3600 * 1000;
  for (const [id, ts] of Object.entries(cache.msgTs)) {
    if (ts < cutoff) { delete cache.msgTs[id]; delete cache.counts[id]; }
  }
  atomicWriteJson(P.msgidCacheFile, cache);
}
function noteInboundMsg(peer, msgId) {
  const now = Date.now();
  cache.peers[peer] = { msgId, ts: now };
  if (msgId) cache.msgTs[msgId] = now;
  persistCache();
}
function passiveCandidate(scope, targetId, explicitMsgId) {
  const windowMs = config.passiveWindowMs[scope] ?? config.passiveWindowMs.c2c;
  const now = Date.now();
  const ids = [];
  if (explicitMsgId) ids.push(explicitMsgId);
  const latest = cache.peers[peerKey(scope, targetId)]?.msgId;
  if (latest && latest !== explicitMsgId) ids.push(latest);
  for (const id of ids) {
    const ts = cache.msgTs[id];
    if (!ts || now - ts > windowMs) continue;
    if ((cache.counts[id] || 0) >= config.passiveReplyLimit) continue;
    return id;
  }
  return null;
}

// ---------- 入站：合并缓冲 ----------
const buffers = new Map(); // peer -> { msgs: [], timer }
function flushBuffer(peer) {
  const buf = buffers.get(peer);
  if (!buf || buf.msgs.length === 0) return;
  buffers.delete(peer);
  const msgs = buf.msgs;
  const first = msgs[0];
  const last = msgs[msgs.length - 1];
  const payload = {
    message_id: last.messageId,
    message_ids: msgs.map((m) => m.messageId),
    scope: first.scope,
    chat_type: first.scope === 'group' ? 'group' : 'p2p',
    target_id: first.targetId,
    sender_open_id: first.senderId,
    sender_name: first.senderName || '',
    text: msgs.map((m) => m.content).filter(Boolean).join('\n'),
    // MVP：附件只记元数据，不下载（下载是二期）；url 是平台临时地址，可能过期。
    attachments: msgs.flatMap((m) => m.attachments || []),
    attachments_downloaded: false,
    create_time: first.timestamp,
    received_at: nowIso(),
    merged_count: msgs.length,
  };
  const file = path.join(P.inboundDir, `${first.messageId}.json`);
  atomicWriteJson(file, payload);
  logger.info(`inbound queued scope=${payload.scope} target=${payload.target_id} sender=${payload.sender_open_id} msgs=${msgs.length} file=${path.basename(file)}`);
}

async function onInbound(msg) {
  if (!msg.messageId || seen.has(msg.messageId)) return;
  seen.add(msg.messageId);
  persistSeen();
  const peer = peerKey(msg.scope, msg.targetId);
  noteInboundMsg(peer, msg.messageId);

  if (!allowed.has(msg.senderId)) {
    appendJsonl(P.strangersFile, {
      at: nowIso(),
      scope: msg.scope,
      target_id: msg.targetId,
      sender_open_id: msg.senderId,
      sender_name: msg.senderName || '',
      message_id: msg.messageId,
      text_preview: (msg.content || '').slice(0, 80),
    });
    logger.warn(`stranger ignored sender=${msg.senderId} scope=${msg.scope} (recorded to queue/strangers.jsonl)`);
    return;
  }
  if (msg.scope === 'group' && msg.senderIsBot) return;

  let buf = buffers.get(peer);
  if (!buf) { buf = { msgs: [], timer: null }; buffers.set(peer, buf); }
  buf.msgs.push(msg);
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => flushBuffer(peer), config.mergeWindowMs);
}

// ---------- 出站 ----------
let outboundBusy = false;
async function processOutboundFile(file, transport) {
  const full = path.join(P.outboundDir, file);
  let job;
  try {
    job = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    const bad = { _error: { at: nowIso(), message: `unparseable outbound json: ${e.message}` } };
    atomicWriteJson(path.join(P.failedDir, file), bad);
    fs.rmSync(full, { force: true });
    return;
  }
  const scope = job.scope === 'group' ? 'group' : 'c2c';
  const targetId = job.targetId || job.target_id;
  const text = job.text ?? job.markdown ?? job.content ?? '';
  const explicitMsgId = job.replyToMsgId || job.reply_to_message_id || job.msgId || null;
  try {
    if (!targetId || !text) throw new Error('outbound job needs targetId and text');
    const chunks = chunkMarkdown(String(text), config.chunkLimit);
    const modes = [];
    for (const chunk of chunks) {
      const msgId = passiveCandidate(scope, targetId, explicitMsgId);
      if (msgId) {
        await transport.sendMarkdown({ scope, targetId, msgId }, chunk);
        cache.counts[msgId] = (cache.counts[msgId] || 0) + 1;
        persistCache();
        modes.push('passive');
      } else if (config.proactiveFallback) {
        await transport.sendMarkdown({ scope, targetId }, chunk);
        modes.push('proactive');
      } else {
        throw new Error('passive reply unavailable (limit/window) and proactiveFallback disabled');
      }
    }
    job._sent = { at: nowIso(), modes, chunks: chunks.length, reply_to: explicitMsgId || cache.peers[peerKey(scope, targetId)]?.msgId || null };
    atomicWriteJson(path.join(P.sentDir, file), job);
    fs.rmSync(full, { force: true });
    logger.info(`outbound sent scope=${scope} target=${targetId} modes=${modes.join(',')} chunks=${chunks.length} file=${file}`);
  } catch (e) {
    job._error = { at: nowIso(), message: String(e?.message || e) };
    atomicWriteJson(path.join(P.failedDir, file), job);
    fs.rmSync(full, { force: true });
    logger.error(`outbound failed file=${file}: ${job._error.message}`);
  }
}

async function outboundLoop(transport) {
  if (outboundBusy) return;
  outboundBusy = true;
  try {
    const files = fs.readdirSync(P.outboundDir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) await processOutboundFile(f, transport);
  } catch (e) {
    logger.error(`outbound loop error: ${e?.message || e}`);
  } finally {
    outboundBusy = false;
  }
}

// ---------- 主流程 ----------
async function main() {
  const transport = DRY_RUN
    ? createDryRunTransport({
      logger,
      inboundFile: process.env.QQ_BRIDGE_SMOKE_INBOUND || '',
      sentFile: process.env.QQ_BRIDGE_SMOKE_SENT || '',
      delayMs: Number(process.env.QQ_BRIDGE_SMOKE_DELAY_MS || 30),
    })
    : await createRealTransport({ credentials: creds, logger });

  let connected = false;
  transport.onReady(() => { connected = true; logger.info('qq gateway ready'); });
  transport.onError((e) => logger.error(`transport error: ${e?.message || e}`));
  transport.onMessage(onInbound);

  fs.writeFileSync(P.pidFile, String(process.pid), 'utf8');
  const heartbeat = setInterval(() => {
    atomicWriteJson(P.heartbeatFile, {
      ts: Math.floor(Date.now() / 1000),
      iso: nowIso(),
      pid: process.pid,
      connected,
      dry_run: DRY_RUN,
    });
  }, config.heartbeatMs);
  heartbeat.unref?.();

  const outboundTimer = setInterval(() => { void outboundLoop(transport); }, config.outboundPollMs);

  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    logger.info(`shutdown signal=${sig}`);
    clearInterval(outboundTimer);
    clearInterval(heartbeat);
    for (const peer of [...buffers.keys()]) flushBuffer(peer);
    try { transport.stop(); } catch { /* ignore */ }
    try { fs.rmSync(P.pidFile, { force: true }); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info(`qq-daemon started pid=${process.pid} dry_run=${DRY_RUN} allowlist=${allowed.size} owner_set=${Boolean(creds.ownerOpenId)}`);
  await transport.start();
  // 真实传输的 start() 在连接终止时 resolve；dry-run 立即返回。
  // daemon 主进程靠定时器与信号存活，不在此退出。
  if (!DRY_RUN) logger.warn('transport start() resolved (connection ended); daemon stays for outbound/heartbeat until signal');
}

main().catch((e) => {
  logger.error(`fatal: ${e?.stack || e}`);
  process.exit(1);
});
