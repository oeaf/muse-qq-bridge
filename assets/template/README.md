# muse-qq-bridge — QQ 机器人 ↔ Muse 桥接模板

把一个 **QQ 官方机器人**（QQ 开放平台 / QQ Bot）接到 Muse 个人助理：用户在 QQ 私聊机器人、或在群里 @ 机器人说话，消息经腾讯官方 SDK 的 WebSocket 网关进入本机文件队列，唤醒 Agent 处理；Agent 的回复再按 QQ 平台的被动回复规则发回去。

设计借鉴腾讯官方 `dsh-qqbot` 的已验证做法（官方 SDK + 被动回复限额 + msgId 缓存 + Markdown 切分），桥接骨架沿用本机 feishu-bridge 的约定（文件队列 + hook 唤醒 + 心跳健康检查）。**不要把真实凭证写进模板目录分发**；部署时复制到运行目录（默认 `~/workspace/qq-bridge/`）后再在本机绑定。

## 链路

```text
用户 QQ 私聊机器人 / 群里 @ 机器人
  -> QQ 开放平台 WebSocket 网关（官方 SDK @tencent-connect/qqbot-nodejs）
  -> bridge/qq-daemon.mjs（白名单、连发合并、被动回复限额、心跳）
  -> queue/inbound/*.json（scope / target_id / sender_open_id / text / 附件元数据）
  -> Agent 唤醒/轮询处理器（hooks/qq_inbox.sh + 工作者）
  -> queue/outbound/*.json（scope / targetId / replyToMsgId / text）
  -> qq-daemon 按被动回复规则 sendMarkdown 发回 QQ
  -> 处理完的出站文件进 queue/sent（失败进 queue/failed）
```

保活：`ops/start.sh`（nohup + pidfile，幂等）或 `ops/qq-bridge.service.example`（systemd user unit，二选一）。
健康层：`state/heartbeat.json` 超过 120 秒未刷新时，`hooks/qq_health.sh` 唤醒运维 Agent 只跑 `ops/start.sh` 恢复。

## 目录

- `bridge/qq-daemon.mjs`：长驻进程。收消息（私聊 + 群 @）、白名单过滤、~1.5 秒连发合并、入队；扫出站队列并发送；维护 `state/msgid-cache.json`（每 peer 最新 msgId + 每 msgId 已回复次数）与 `state/heartbeat.json`；SIGINT/SIGTERM 优雅退出（退出前冲刷未落盘的合并消息）。
- `bridge/transport.mjs`：传输抽象层。真实实现包官方 SDK；`--dry-run` 实现读脚本喂入站、把出站记成 JSONL，供冒烟测试，业务代码不感知差异。
- `bridge/bind.mjs`：凭证绑定。首选扫码（官方 `@tencent-connect/qqbot-connector`，凭据直接回传本机）；`--manual` 从环境变量读 AppID/AppSecret；落盘 `config/credentials.json` 并 chmod 0600；永不回显 AppSecret。
- `bridge/send.mjs`：出站入队小工具（`--scope/--target/--text|--file/--reply-to`）。
- `bridge/chunker.mjs`：出站 Markdown 切分（默认 4500 字符/条，段落边界优先，代码围栏不拆）。
- `bridge/smoke-test.mjs`：dry-run 冒烟测试（陌生人拦截、被动上限降级、切分器等断言）。
- `hooks/qq_inbox.sh` / `hooks/qq_health.sh`：Muse hooks 检测脚本；`hooks/prompts.md` 是两个工作者的提示词模板。
- `config/credentials.example.json` / `config/config.example.json`：凭证与非秘密配置模板。
- `ops/start.sh` / `stop.sh` / `status.sh`：启停与状态（不读秘密值）。
- `CHECKLIST.md`：从 0 到验收的逐项清单。`INSTALL.md`：给安装者（人或 Agent）的分步说明。

## 接口约定

### inbound（每条/每组消息一个文件，`queue/inbound/*.json`）

```json
{
  "message_id": "最后一条消息的 id",
  "message_ids": ["连发合并时的全部 id"],
  "scope": "c2c | group",
  "chat_type": "p2p | group",
  "target_id": "私聊=对方 openid；群聊=群 openid",
  "sender_open_id": "发送者 openid",
  "sender_name": "昵称（可能为空）",
  "text": "消息文本（合并时以换行拼接）",
  "attachments": [{"content_type": "...", "filename": "...", "size": 0, "url": "..."}],
  "attachments_downloaded": false,
  "create_time": "平台时间戳",
  "received_at": "本机 ISO 时间",
  "merged_count": 1
}
```

### outbound（`queue/outbound/*.json`，daemon 发送后移入 sent/failed 并回填 `_sent`/`_error`）

```json
{
  "scope": "c2c | group",
  "targetId": "对方 openid 或群 openid",
  "replyToMsgId": "挂靠的入站消息 id（可省略，默认挂该 peer 最新一条）",
  "text": "回复正文（Markdown）"
}
```

## QQ 平台规则（必须知道）

- **被动回复**：回复必须挂在用户那条消息的 msgId 上；**同一条消息最多被动回复 4 次**，且有有效期窗口（私聊约 30 分钟、群聊约 5 分钟，以平台实际为准）。超限或过期后只能走**主动消息**，主动消息有平台额度与频率限制，别滥用。daemon 内置限额计数：耗尽/过期自动降级主动（配置 `proactiveFallback` 可关）。
- **群聊要 @**：机器人默认只收到群里 @ 它的消息（`GROUP_AT_MESSAGE_CREATE`）；不 @ 不推送，这是平台规则不是 bug。
- **Markdown**：机器人需具备 Markdown 消息权限（开放平台后台申请/默认开通情况以账号为准）；长回复由 chunker 切成多条，每条都占一次被动回复额度。
- **openid 不是 QQ 号**：openid 按机器人应用隔离，同一人在不同机器人下 openid 不同；白名单认 openid，不认 QQ 号。
- 沙盒/测试与正式环境的可用范围、审核要求以 q.qq.com 后台当时的规则为准；遇到平台验证墙或审核拦截，停下来找所有者处理，不要硬闯。

## 安全模型

- **默认拒绝**：只有 `credentials.json` 里 `ownerOpenId` 与 `allowedOpenIds` 的发送者会被处理；其他人一律只登记到 `queue/strangers.jsonl`（openid + 时间 + 文本预览），不回复、不自动放行。认领主人身份要由所有者对照 strangers 记录确认后手工回填。
- **凭证只在本机**：AppSecret 等同密码。只存运行目录 `config/credentials.json`（0600，进 .gitignore）；不进 skill/模板/代码/日志/聊天/记忆。扫码绑定时凭据由官方 connector 直接回传本机，不经任何聊天通道。
- **不主动打扰**：禁止向白名单外的人发送主动消息；主动消息只用于被动额度耗尽时完成对主人的一次回复降级。
- **桥接侧边界**：QQ 里只承接所有者约定的轻量工作；付款、向外发信/发布、重要删除、高价值账号设置等后果性动作，不能只凭一句 QQ 消息执行，要回主聊天确认（工作者提示词已写明）。

## MVP 范围与二期

- 已实现：私聊文字、群 @ 文字、连发合并、附件**元数据**记录、白名单、被动回复限额与降级、Markdown 切分、心跳与健康恢复、dry-run 冒烟测试。
- 二期（未实现，不要声称已支持）：入站附件下载到本地供 Agent 分析、出站图片/文件/语音发送、流式回复、按钮交互（提问/审批通道）、频道消息。
