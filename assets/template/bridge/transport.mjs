// 传输层：把 QQ 平台接入抽象成一个小接口，daemon 只依赖这个接口。
//
// interface Transport {
//   onMessage(fn): void   // fn(normalizedMsg) — 入站消息（已归一化）
//   onReady(fn): void     // 连接就绪
//   onError(fn): void     // 传输错误（不含单条发送失败）
//   sendMarkdown(target, content): Promise<{id?: string}>
//        // target = { scope: 'c2c'|'group', targetId, msgId? }
//        // 带 msgId = 被动回复；不带 = 主动消息。由 daemon 决定，传输层只执行。
//   start(): Promise<void>
//   stop(): void
// }
//
// normalizedMsg = {
//   kind: 'c2c'|'group', scope: 'c2c'|'group',
//   senderId, senderName, content, messageId, timestamp,
//   groupOpenid?, targetId, attachments: [{content_type, filename, size, url, width, height}]
// }
//
// 两种实现：
// - real：腾讯官方 SDK @tencent-connect/qqbot-nodejs（WebSocket 网关）。
// - dry-run：不连网，读脚本文件喂入站、把出站记到 JSONL，供冒烟测试。

import fs from 'node:fs';
import { appendJsonl } from './lib.mjs';

function normalizeSdkMessage(msg) {
  const scope = msg.kind === 'group' ? 'group' : 'c2c';
  const targetId = msg.replyTarget?.targetId
    ?? (scope === 'group' ? msg.groupOpenid : msg.senderId);
  return {
    kind: scope,
    scope,
    senderId: msg.senderId,
    senderName: msg.senderName || '',
    content: msg.content || '',
    messageId: msg.messageId,
    timestamp: msg.timestamp || new Date().toISOString(),
    groupOpenid: msg.groupOpenid,
    targetId,
    attachments: (msg.attachments || []).map((a) => ({
      content_type: a.content_type,
      filename: a.filename,
      size: a.size,
      url: a.url,
      width: a.width,
      height: a.height,
    })),
  };
}

export async function createRealTransport({ credentials, logger }) {
  const { QQBot } = await import('@tencent-connect/qqbot-nodejs');
  const sdkLogger = {
    info: (m, ...a) => logger.info(`[sdk] ${m} ${a.length ? JSON.stringify(a).slice(0, 200) : ''}`.trim()),
    warn: (m, ...a) => logger.warn(`[sdk] ${m} ${a.length ? JSON.stringify(a).slice(0, 200) : ''}`.trim()),
    error: (m, ...a) => logger.error(`[sdk] ${m} ${a.length ? JSON.stringify(a).slice(0, 200) : ''}`.trim()),
    debug: () => {},
  };
  const bot = new QQBot({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    transport: 'websocket',
    baseUrl: 'https://api.bot.qq.com',
    tokenBaseUrl: 'https://api.bot.qq.com',
    logger: sdkLogger,
  });
  const t = {
    _msgFn: null,
    onMessage(fn) { this._msgFn = fn; },
    onReady(fn) { bot.on('ready', () => fn()); },
    onError(fn) { bot.on('error', (e) => fn(e)); },
    async sendMarkdown(target, content) {
      const clean = { scope: target.scope, targetId: target.targetId };
      if (target.msgId) clean.msgId = target.msgId;
      const res = await bot.sendMarkdown(clean, content);
      return { id: res?.id };
    },
    async start() {
      bot.on('message', async (_ctx, msg) => {
        try {
          if (this._msgFn) await this._msgFn(normalizeSdkMessage(msg));
        } catch (e) {
          logger.error(`inbound handler error: ${e?.message || e}`);
        }
      });
      // start() 在连接终止时才 resolve；daemon 不阻塞等待它。
      const p = bot.start();
      p.catch((e) => logger.error(`bot.start failed: ${e?.message || e}`));
      return p;
    },
    stop() { try { bot.stop(); } catch { /* ignore */ } },
  };
  return t;
}

export function createDryRunTransport({ logger, inboundFile, sentFile, delayMs = 30 }) {
  let sentCount = 0;
  const t = {
    _msgFn: null,
    _readyFn: null,
    onMessage(fn) { this._msgFn = fn; },
    onReady(fn) { this._readyFn = fn; },
    onError() {},
    async sendMarkdown(target, content) {
      sentCount += 1;
      const record = {
        target: { scope: target.scope, targetId: target.targetId, ...(target.msgId ? { msgId: target.msgId } : {}) },
        content,
        at: new Date().toISOString(),
      };
      if (sentFile) appendJsonl(sentFile, record);
      logger.info(`[dry-run] sendMarkdown -> ${target.scope}:${target.targetId} msgId=${target.msgId || '-'} len=${content.length}`);
      return { id: `dry-${sentCount}` };
    },
    async start() {
      if (this._readyFn) this._readyFn();
      let items = [];
      if (inboundFile && fs.existsSync(inboundFile)) {
        const raw = fs.readFileSync(inboundFile, 'utf8').trim();
        if (raw.startsWith('[')) items = JSON.parse(raw);
        else if (raw) items = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      }
      for (const item of items) {
        const scope = item.kind === 'group' || item.scope === 'group' ? 'group' : 'c2c';
        const msg = {
          kind: scope,
          scope,
          senderId: item.senderId,
          senderName: item.senderName || '',
          content: item.content || '',
          messageId: item.messageId,
          timestamp: item.timestamp || new Date().toISOString(),
          groupOpenid: item.groupOpenid,
          targetId: scope === 'group' ? (item.groupOpenid || item.targetId) : item.senderId,
          attachments: item.attachments || [],
        };
        if (this._msgFn) await this._msgFn(msg);
        await new Promise((r) => setTimeout(r, delayMs));
      }
      logger.info(`[dry-run] scripted inbound exhausted (${items.length} messages)`);
      // dry-run start() 不阻塞：daemon 靠信号/外部停止退出。
      return Promise.resolve();
    },
    stop() {},
  };
  return t;
}
