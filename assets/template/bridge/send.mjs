// 出站入队小工具：把一条回复写进 queue/outbound/，由 daemon 负责真正发送。
// Agent/hook 一般直接写 outbound 文件即可；这个 CLI 是给人手和脚本用的便捷入口。
//
// 用法：
//   node bridge/send.mjs --scope c2c   --target <user_openid>  --text "回复内容"
//   node bridge/send.mjs --scope group --target <group_openid> --file reply.md --reply-to <msgId>
//
// 注意：不带 --reply-to 时 daemon 会挂到该 peer 最近一条入站消息上做被动回复；
// 若额度/窗口不可用且配置允许，会降级为主动消息。给陌生人发主动消息前先想清楚——
// 白名单外的人不要主动发（见 README 安全模型）。

import fs from 'node:fs';
import path from 'node:path';
import { resolveRoot, paths, ensureDirs, atomicWriteJson } from './lib.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const scope = arg('--scope');
const targetId = arg('--target');
const replyTo = arg('--reply-to');
let text = arg('--text');
const file = arg('--file');
if (file) text = fs.readFileSync(file, 'utf8');

if (!scope || !targetId || !text) {
  console.error('usage: node bridge/send.mjs --scope c2c|group --target <openid> (--text <text> | --file <path>) [--reply-to <msgId>]');
  process.exit(2);
}

const root = resolveRoot();
const P = paths(root);
ensureDirs(P);
const name = `${Date.now()}-${scope}-${Math.random().toString(36).slice(2, 8)}.json`;
const job = { scope, targetId, text, ...(replyTo ? { replyToMsgId: replyTo } : {}) };
atomicWriteJson(path.join(P.outboundDir, name), job);
console.log(`queued: queue/outbound/${name}`);
