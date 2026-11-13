// muse-qq-bridge 共享工具：路径、配置、原子写、日志。
// 只用 Node 内置模块。任何函数都不打印凭证值。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveRoot() {
  if (process.env.QQ_BRIDGE_ROOT) return path.resolve(process.env.QQ_BRIDGE_ROOT);
  // bridge/ 的上一级即运行根目录
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function paths(root) {
  return {
    root,
    configDir: path.join(root, 'config'),
    credentialsFile: path.join(root, 'config', 'credentials.json'),
    configFile: path.join(root, 'config', 'config.json'),
    queueDir: path.join(root, 'queue'),
    inboundDir: path.join(root, 'queue', 'inbound'),
    outboundDir: path.join(root, 'queue', 'outbound'),
    sentDir: path.join(root, 'queue', 'sent'),
    failedDir: path.join(root, 'queue', 'failed'),
    processedDir: path.join(root, 'queue', 'processed'),
    strangersFile: path.join(root, 'queue', 'strangers.jsonl'),
    stateDir: path.join(root, 'state'),
    heartbeatFile: path.join(root, 'state', 'heartbeat.json'),
    msgidCacheFile: path.join(root, 'state', 'msgid-cache.json'),
    seenFile: path.join(root, 'state', 'seen_message_ids.json'),
    pidFile: path.join(root, 'state', 'daemon.pid'),
    logsDir: path.join(root, 'logs'),
    daemonLog: path.join(root, 'logs', 'daemon.log'),
  };
}

export function ensureDirs(p) {
  for (const d of [p.configDir, p.inboundDir, p.outboundDir, p.sentDir,
    p.failedDir, p.processedDir, p.stateDir, p.logsDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

let tmpCounter = 0;
export function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++tmpCounter}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++tmpCounter}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeLogger(logFile) {
  const write = (level, msg) => {
    const line = `[${nowIso()}] ${level} ${msg}`;
    console.log(line);
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, line + '\n', 'utf8');
    } catch { /* 日志文件写失败不拖垮 daemon */ }
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    debug: (m) => write('DEBUG', m),
  };
}

export const DEFAULT_CONFIG = {
  mergeWindowMs: 1500,          // 同一 peer 连发消息的合并等待（静默多久后落盘）
  outboundPollMs: 1000,         // 出站队列轮询间隔
  heartbeatMs: 15000,           // 心跳写入间隔
  passiveWindowMs: { c2c: 30 * 60 * 1000, group: 5 * 60 * 1000 }, // 平台被动回复窗口
  passiveReplyLimit: 4,         // 同一 msgId 最多被动回复次数（平台上限口径）
  proactiveFallback: true,      // 被动额度耗尽/过期时是否降级主动消息
  chunkLimit: 4500,             // 出站 markdown 单条切分上限
  requireMentionInGroup: true,  // 群聊仅处理 @ 机器人的消息（平台默认只推送 @ 事件）
};

export function loadConfig(p) {
  const raw = readJsonSafe(p.configFile, {}) || {};
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    passiveWindowMs: { ...DEFAULT_CONFIG.passiveWindowMs, ...(raw.passiveWindowMs || {}) },
  };
}

export function loadCredentials(p) {
  const creds = readJsonSafe(p.credentialsFile, null);
  if (!creds) return null;
  return {
    appId: String(creds.appId || ''),
    appSecret: String(creds.appSecret || ''),
    ownerOpenId: String(creds.ownerOpenId || ''),
    allowedOpenIds: Array.isArray(creds.allowedOpenIds) ? creds.allowedOpenIds.map(String) : [],
  };
}

export function peerKey(scope, targetId) {
  return `${scope}:${targetId}`;
}
