# muse-qq-bridge 完整指南

## 架构与数据流

```text
QQ 用户 ──私聊/群@──> QQ 开放平台 ──WebSocket 网关──> qq-daemon.mjs
qq-daemon.mjs ──白名单/合并/去重──> queue/inbound/*.json
hooks/qq_inbox.sh（15s 轮询检测）──唤醒──> Agent 工作者
工作者 ──写回复──> queue/outbound/*.json ──> qq-daemon.mjs
qq-daemon.mjs ──被动回复(挂 msgId, ≤4 次/窗口内) 或降级主动──> SDK sendMarkdown ──> QQ 用户
hooks/qq_health.sh（60s）──心跳陈旧──> 运维工作者只跑 ops/start.sh
```

关键设计（借鉴官方 dsh-qqbot 的已验证实现）：

- 协议层全部交给官方 SDK `@tencent-connect/qqbot-nodejs`：access_token 生命周期、WebSocket 心跳/RESUME/重连、REST 发送。本桥不自己实现任何 QQ 协议细节。
- 被动回复三要素：msgId 缓存（`state/msgid-cache.json`：每 peer 最新 msgId + 每 msgId 时间戳与已用次数）、限额（同一 msgId 最多 4 条）、窗口（私聊 30 分钟/群聊 5 分钟，`config.json` 的 `passiveWindowMs` 可调）。三者任一不满足即判定被动不可用。
- 长文切分：单条上限默认 4500 字符；每个 chunk 各占一次回复计数，发送循环里逐 chunk 重新判定被动/主动，所以一条长回复可能前几段被动、尾段主动，这是预期行为。
- 连发合并：同一 peer 的消息在 `mergeWindowMs`（默认 1500ms）静默后合并成一个 inbound 文件，`text` 以换行拼接，`message_ids` 保留全部 id，回复挂最后一条的 id。
- 去重：`state/seen_message_ids.json` 持久保存已处理 message_id（上限 5000 条滚动），网关重投不会重复入队。

## 凭证与绑定细节

- 扫码绑定走官方 `@tencent-connect/qqbot-connector` 的 `startQrConnect(callbacks, options)`：回调风格，`onQrDisplayed(url)` 给出二维码链接（包自身也会在终端打印二维码），`onSuccess(credentials[])` 回传数组（当前长度 1），元素含 `appId`、`appSecret`，以及 `userOpenid`（扫码者 openid，可作主人候选，仍须所有者确认）。
- `bind.mjs` 落盘后 chmod 0600；已有完整凭证时默认拒绝覆盖，`--force` 才重绑。
- 手工模式只读环境变量，不提供交互式输入秘密（避免秘密进 shell 历史之外的聊天/日志面）；所有者在本机终端执行即可。
- daemon 只读 `config/credentials.json`；缺失即退出码 2 并提示先 bind，绝不尝试空凭证连网。

## hooks 合同（与 feishu 桥同构）

- 检测脚本只做三件事：看目录/心跳、写 hook 日志、silent 或 wake。绝不在检测脚本里读消息正文或凭证。
- inbox 检测以"文件存在"为信号：工作者处理完把文件移入 `queue/processed/`，失败则留原地，下轮重试。因此工作者必须幂等：同一文件重复处理时不要重复发送（写 outbound 前先检查 processed 与 sent 里是否已有同 message_id 的 reply 文件）。
- health 检测：心跳阈值 120 秒，30 分钟内不重复唤醒（hook state）；恢复动作只有 `ops/start.sh` 一条路，禁止工作者自己拼启动命令或读凭证内容。

## 平台规则备忘（以 q.qq.com 后台当时规则为准）

| 事项 | 口径 |
|---|---|
| 被动回复次数 | 同一 msgId 最多 4 条（dsh-qqbot 与本桥都按 4 实现） |
| 被动窗口 | 私聊约 30 分钟、群约 5 分钟（dsh msgid-cache 的 TTL 口径） |
| 主动消息 | 有额度与频率限制；仅用于被动不可用时完成对主人的回复 |
| 群消息推送 | 默认只推 @ 机器人的消息（GROUP_AT_MESSAGE_CREATE） |
| Markdown | msg_type=2；需机器人具备 Markdown 权限；单条长度上限约 5000 字符 |
| openid | 按应用隔离；不能跨机器人复用；不是 QQ 号 |

## 排错表

| 现象 | 先查 | 处理 |
|---|---|---|
| daemon 启动即退出码 2 | `config/credentials.json` 不存在或为空 | 先跑 `node bridge/bind.mjs`（所有者扫码），再启动 |
| token 换取失败/凭证无效 | AppID/AppSecret 是否配对、机器人是否被重置过 Secret | 停自动重试；所有者重新扫码绑定（`--force`）；不要猜、不要从聊天记录回捞 |
| 日志无 `qq gateway ready` | 网络到 `api.bot.qq.com` 是否通、SDK 报错原文 | 报阶段与简短原因给所有者；检查代理/防火墙 |
| 用户发消息毫无反应 | daemon 是否在跑、心跳是否新鲜、发送者是否在白名单 | 白名单外只进 `queue/strangers.jsonl`（设计如此）；认领后回填 openid 并重启 |
| 群里发消息没反应 | 是否 @ 了机器人 | 平台默认不推未 @ 消息；@ 后再测 |
| 回复发送失败 | outbound 文件是否进了 `queue/failed` 及其 `_error` | Markdown 权限未开通、被动窗口过期且主动额度不足是常见原因；按错误原因处理，不要无脑重发 |
| 回复变成主动消息 | `_sent.modes` 含 proactive | 说明被动额度/窗口已不可用：多半是处理太慢（窗口过期）或同一条消息回复次数过多；优化处理时延，别调高限额硬顶平台规则 |
| 两套桥同时在跑 | `ops/status.sh` 的 pid 与实际进程数 | 停掉一套；同机器人双消费者会互相抢消息 |

## 二期路线（未实现）

1. 入站附件下载：按 SDK 的附件 url 在入队时下载到 `queue/incoming_attachments/<message_id>/`，inbound 里回填本地路径，合同对齐 feishu 桥。
2. 出站媒体：sendImage/sendFile 等 SDK 方法 + outbound 文件加 `attachments` 字段；文件发送不支持 event_id 被动口径，需单独的回复目标解析。
3. 流式回复：SDK 的 `openStream`（仅私聊）与分段编辑。
4. 按钮交互：提问/审批通道（interaction 事件 + acknowledge），参照 dsh 的 question/approval channel 设计。
