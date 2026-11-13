# 安装说明（给安装者：人或 Agent）

目标：把模板部署成一个能收发 QQ 消息的本地桥。默认运行目录 `~/workspace/qq-bridge`。全程只有**一步需要人类动手**：扫码绑定（或提供已建好的机器人凭证）。其余步骤安装者自己完成并逐项验收，不要凭感觉跳步；细项打勾表见 `CHECKLIST.md`。

## 0. 前置

- Node.js ≥ 20（`node --version` 确认）。
- 本机能访问 QQ 开放平台接口（`api.bot.qq.com` / `bots.qq.com`）。
- 确认不是重复部署：目标目录、进程（`ops/status.sh`）、hooks 里没有另一套同机器人桥在跑。一套机器人只能有一个消费者。

## 1. 部署模板

```bash
# 在 skill 目录下：
bash bin/install_template.sh ~/workspace/qq-bridge --install-deps
# 它会：复制模板 -> 生成 config/config.json（仅非秘密字段）-> npm install
# 它不会生成真实 credentials.json，也不会覆盖已有 config.json。
```

或手工等价操作：复制 `assets/template/` 到运行目录，`cp config/config.example.json config/config.json`，在运行目录 `npm install`。

## 2. 绑定凭证（唯一需要所有者的步骤）

首选扫码绑定：

```bash
cd ~/workspace/qq-bridge
node bridge/bind.mjs
```

终端会打印二维码与链接。**请所有者本人用手机 QQ 扫码**（扫码即创建/绑定一个机器人到其账号下）。成功后脚本把 `appId/appSecret` 写入 `config/credentials.json`（0600），并把扫码者 openid 记为 `ownerOpenId` 候选——请所有者确认扫码用的就是其本人 QQ 后再继续。

备选（所有者已在 https://q.qq.com 建好机器人）：

```bash
QQ_APPID=<AppID> QQ_SECRET=<AppSecret> node bridge/bind.mjs --manual
```

铁律：**不要让所有者把 AppSecret 贴进聊天**。它等同密码：要么走扫码（根本不经过聊天），要么由所有者在本机终端/安全录入里提供。校验：`node bridge/bind.mjs --check`（只报 set/长度/权限，不报值）。

## 3. 冒烟测试（不连网）

```bash
node bridge/smoke-test.mjs
```

期望结尾 `SMOKE RESULT: ALL PASS`。不过先修，别带病上线。

## 4. 启动

```bash
bash ops/start.sh        # nohup + pidfile，幂等
bash ops/status.sh       # 进程在、心跳新鲜、connected=true
tail -f logs/daemon.log  # 应出现 qq gateway ready
```

或用 systemd user unit：改 `ops/qq-bridge.service.example` 路径后放 `~/.config/systemd/user/qq-bridge.service`，`systemctl --user enable --now qq-bridge`。**两种保活二选一，不要叠加**。

## 5. 注册唤醒 hooks（Muse 环境）

1. 把 `hooks/qq_inbox.sh`、`hooks/qq_health.sh` 复制到 hooks 目录，脚本内路径改成真实运行目录。
2. 按 `hooks/prompts.md` 注册两个工作者（替换占位符；提示词里不放任何凭证）：
   - `qq-inbox` 每 15 秒：空队列 dry-run 应为 silent；放一份假 inbound 后 dry-run 应为 wake；清掉假消息再 enable。
   - `qq-health` 每 60 秒：健康时 dry-run 应为 silent；手工走读心跳陈旧分支再 enable。
3. 非 Muse 环境：用自己的定时任务实现同一份文件合同（inbound 非空 -> 唤醒处理者；heartbeat 陈旧 -> 跑 `ops/start.sh`）。

## 6. 端到端验收（必须真发消息）

1. 所有者用 QQ 给机器人发一条约定测试语（私聊）。
2. 四段对齐：daemon 日志出现 inbound queued -> `queue/inbound` 出现文件 -> 工作者写出 outbound -> daemon 日志 outbound sent 且 QQ 端亲眼收到回复。
3. 若这是陌生 openid（扫码没拿到 openid 时）：所有者的消息会先进 `queue/strangers.jsonl`。对照确认是本人后，把该 openid 填进 `config/credentials.json` 的 `ownerOpenId`，重启 daemon（`ops/stop.sh && ops/start.sh`），再发一条验证入队。
4. 群聊（可选）：把机器人拉进一个群，@ 它发一句，验证收到并回复；不 @ 时不应有反应（平台不推送）。

## 7. 收尾报告

按 `CHECKLIST.md` 第 8 节给状态矩阵：绑定方式、进程/心跳、白名单、文字端到端、群聊是否已测、保活方式、仍存在的上限（附件下载等二期项）。每项写证据来源，不把日志一行字当成用户端已收到的替代证据。

## 停止 / 回滚

```bash
bash ops/stop.sh
```

卸载：停进程、注销 hooks/systemd unit；是否删除 `config/credentials.json` 与队列证据由所有者决定，安装者不要擅自删。
