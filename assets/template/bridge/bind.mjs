// 凭证绑定：把 QQ 机器人的 AppID/AppSecret 安全地写进 config/credentials.json（0600）。
//
// 两种模式：
//   node bridge/bind.mjs           扫码绑定（首选）：用手机 QQ 扫终端里的二维码，
//                                  凭据由腾讯官方 connector 直接回传本机并落盘；
//                                  扫码者的 openid 会一并记下，作为主人白名单候选。
//   node bridge/bind.mjs --manual  手工模式：从环境变量 QQ_APPID / QQ_SECRET 读入并落盘。
//                                  适合所有者已在 q.qq.com 建好机器人的情况。
//                                  绝不要把 AppSecret 贴进聊天记录——它等同密码。
//   node bridge/bind.mjs --check   只校验现有 credentials.json 的形状（不打印秘密值）。
//
// 本脚本从不回显 AppSecret（最多报长度）。

import fs from 'node:fs';
import {
  resolveRoot, paths, ensureDirs, readJsonSafe, atomicWriteJson, nowIso,
} from './lib.mjs';

const root = resolveRoot();
const P = paths(root);
ensureDirs(P);

function writeCredentials({ appId, appSecret, ownerOpenId = '', allowedOpenIds = [] }) {
  const data = {
    appId: String(appId),
    appSecret: String(appSecret),
    ownerOpenId: String(ownerOpenId || ''),
    allowedOpenIds: Array.isArray(allowedOpenIds) ? allowedOpenIds.map(String) : [],
    _bound_at: nowIso(),
  };
  atomicWriteJson(P.credentialsFile, data);
  fs.chmodSync(P.credentialsFile, 0o600);
  return data;
}

function checkExisting() {
  const c = readJsonSafe(P.credentialsFile, null);
  if (!c) {
    console.log('credentials.json: MISSING');
    return 2;
  }
  const mode = (fs.statSync(P.credentialsFile).mode & 0o777).toString(8);
  const ok = Boolean(c.appId && c.appSecret);
  console.log(`credentials.json: ${ok ? 'OK' : 'INCOMPLETE'} appId=${c.appId ? 'set' : 'empty'} appSecret=${c.appSecret ? `set(len=${String(c.appSecret).length})` : 'empty'} ownerOpenId=${c.ownerOpenId ? 'set' : 'empty'} allowed=${(c.allowedOpenIds || []).length} perms=${mode}`);
  return ok ? 0 : 2;
}

async function manual() {
  const appId = process.env.QQ_APPID || '';
  const appSecret = process.env.QQ_SECRET || '';
  if (!appId || !appSecret) {
    console.error('manual mode needs env QQ_APPID and QQ_SECRET (non-empty). Refusing to prompt for secrets in chat/logs.');
    return 2;
  }
  const prev = readJsonSafe(P.credentialsFile, {}) || {};
  writeCredentials({
    appId, appSecret,
    ownerOpenId: prev.ownerOpenId || '',
    allowedOpenIds: prev.allowedOpenIds || [],
  });
  console.log(`credentials written (0600). appId=${appId} appSecret=set(len=${appSecret.length})`);
  return 0;
}

async function qr() {
  const prev = readJsonSafe(P.credentialsFile, null);
  if (prev?.appId && prev?.appSecret && !process.argv.includes('--force')) {
    console.log('credentials.json already exists and looks complete; use --force to rebind.');
    return checkExisting();
  }
  let startQrConnect;
  try {
    ({ startQrConnect } = await import('@tencent-connect/qqbot-connector'));
  } catch (e) {
    console.error(`qqbot-connector unavailable (${e.message}). Fall back: create a bot at https://q.qq.com, then run: QQ_APPID=<id> QQ_SECRET=<secret> node bridge/bind.mjs --manual`);
    return 2;
  }
  console.log('请机器人所有者用手机 QQ 扫描下面二维码（或打开随后打印的链接）。扫码后凭据自动回传本机，全程不经聊天。');
  return new Promise((resolve) => {
    let done = false;
    const stop = startQrConnect({
      onQrDisplayed(url) {
        console.log(`二维码链接: ${url}`);
        console.log('（终端二维码由 connector 打印；若看不到，复制链接到任意二维码生成器再扫。）');
      },
      onQrExpired() {
        console.log('二维码已过期，正在刷新…');
      },
      onSuccess(credentialsList) {
        if (done) return;
        done = true;
        const c = credentialsList?.[0];
        if (!c?.appId || !c?.appSecret) {
          console.error('bind failed: connector returned empty credentials');
          resolve(2);
          return;
        }
        const data = writeCredentials({
          appId: c.appId,
          appSecret: c.appSecret,
          ownerOpenId: c.userOpenid || prev?.ownerOpenId || '',
          allowedOpenIds: prev?.allowedOpenIds || [],
        });
        console.log(`绑定成功。appId=${data.appId} appSecret=set(len=${data.appSecret.length}) 已写入 config/credentials.json (0600)`);
        if (data.ownerOpenId) {
          console.log('已把扫码者 openid 记为 ownerOpenId 候选；请所有者确认这就是本人后再启动 daemon。');
        } else {
          console.log('未拿到扫码者 openid：先启动 daemon，让所有者给机器人发一条消息，再从 queue/strangers.jsonl 里认领自己的 openid 填回 ownerOpenId 并重启。');
        }
        resolve(0);
      },
      onFailure(err) {
        if (done) return;
        done = true;
        console.error(`bind failed: ${err?.message || err}`);
        resolve(2);
      },
    }, { displayQrCodeToConsole: true, source: 'muse-qq-bridge' });
    process.on('SIGINT', () => { try { stop(); } catch { /* ignore */ } resolve(130); });
  });
}

const mode = process.argv.includes('--check') ? 'check'
  : process.argv.includes('--manual') ? 'manual' : 'qr';
const code = mode === 'check' ? checkExisting() : mode === 'manual' ? await manual() : await qr();
process.exit(code);
