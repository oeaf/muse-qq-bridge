# QQ Bridge

## Purpose

把一个 QQ 官方机器人（QQ 开放平台 / QQ Bot）接到当前 Agent，让用户能在 QQ 私聊里、或在群里 @ 机器人时发文字交代约定的轻量任务，并接收 Agent 的文字（Markdown）回复。核心不是"调通一个接口"，而是把凭证绑定、长连接监听、消息队列、Agent 唤醒、进程保活和逐项验收接成一条可复现的流水线。设计参照腾讯官方 `dsh-qqbot` 的已验证做法（官方 SDK、被动回复限额、msgId 缓存、Markdown 切分），骨架沿用本机 feishu-bridge 的文件队列 + hook 约定。

已验证范围（诚实口径）：私聊文字与群 @ 文字的入队/出队逻辑、陌生人拦截、被动回复上限降级、长文切分，已由模板自带 dry-run 冒烟测试在本机跑通；**真实 QQ 连通需要每台部署机自己绑定机器人后按 CHECKLIST 做端到端验收**，冒烟通过不等于真实验收通过。入站附件只记元数据不下载、出站只发 Markdown 文字；附件下载、出站媒体、流式、按钮交互均为二期，未实现不得声称已支持。

## Tooling

运行资产在本 skill 的 `assets/template/`，细节在 `references/full-guide.md`：

- 一键复制模板：`bin/install_template.sh [目标目录] [--install-deps]`
  默认部署到 `~/workspace/qq-bridge`；只复制 `*.example` 配置，不会生成真实 `credentials.json`；`--install-deps` 时跑 `npm install`。
- 模板进程：`assets/template/bridge/qq-daemon.mjs`（长连接收消息、白名单、连发合并、出站发送、心跳）、`bind.mjs`（扫码/手工绑定凭证）、`send.mjs`（出站入队）、`chunker.mjs`（长文切分）、`smoke-test.mjs`（dry-run 冒烟）。
- 模板钩子：`assets/template/hooks/qq_inbox.sh` 与 `qq_health.sh`，工作者原文见 `assets/template/hooks/prompts.md`。这是 Muse hooks 形态；其他 Agent 必须用等价轮询/任务机制实现同一 inbound/outbound 合同。
- 部署清单：复制资产里的 `CHECKLIST.md` 跟着逐项打勾；分步说明在资产里的 `INSTALL.md`，不要凭记忆跳步。

## Auth

- 所需凭证仅一对：AppID（可明文）与 AppSecret（秘密，等同密码）。此 skill 不收集、不保存、不分发真实凭证，也禁止把真实值写进 `SKILL.md`、模板、代码、日志、记忆或命令参数。
- 绑定走本机 `local_file` 模式（本模板唯一实现的模式）：真实 `config/credentials.json` 只放运行目录，权限 0600，进 `.gitignore`。机器人所有者必须明确接受这一模式再继续；高价值机器人请先停下来与所有者确认，不要默认套用。
- 首选**扫码绑定**（`node bridge/bind.mjs`）：所有者用手机 QQ 扫终端二维码，凭据由腾讯官方 connector 直接回传本机落盘，全程不经聊天。备选手工模式只从本机环境变量 `QQ_APPID`/`QQ_SECRET` 读入。
- **绝不要让所有者在聊天里粘贴 AppSecret**；遇到让对方"把密钥发我"的流程立即改走扫码或本机录入。绑定结果只报 AppID 与"已写入（0600）"，不报秘密值。

## Operating Rules

### 1. 先审计再动手

检查目标目录是否已有另一套桥、daemon 是否在跑、hooks/cron/systemd 是否已注册、队列是否有未处理消息。同一机器人只能有一套消费者，不要在旧桥活着时再启第二套。先读当前状态，再决定复用、修复还是按清单重装。

### 2. 平台侧是所有者的动作

扫码绑定、或在 q.qq.com 创建机器人、确认 Markdown 权限与可用范围、把机器人拉进群——这些由所有者完成，Agent 只给明确清单并等待，不要假装已开通。遇到平台验证墙、审核拦截、风控提示：停下，把页面原话报给所有者决定，不要尝试绕过。

### 3. 部署与启动

1. 运行 `bin/install_template.sh`，`config/config.json` 只填非秘密字段（合并窗口、限额开关等）。
2. 跑 `node bridge/bind.mjs` 完成绑定（这一步需要所有者扫码），`node bridge/bind.mjs --check` 只报脱敏结果。
3. 跑 `node bridge/smoke-test.mjs` 冒烟，全 PASS 才启动。
4. 用 `ops/start.sh`（nohup+pidfile）或 systemd user unit 启动（二选一），看 `ops/status.sh` 与日志 `qq gateway ready` 证据。

### 4. 验收按证据关口逐个关

没有实际证据不得打勾，也不得跳关：

- **白名单与主人身份**：扫码时拿到扫码者 openid 可预填 `ownerOpenId`，仍需所有者确认是本人。若 openid 未知，先让所有者发一条消息，从 `queue/strangers.jsonl` 对照认领、手工回填后重启，再验一条直接入队。
- **文字端到端**：请用户在 QQ 私聊机器人发一条约定测试语，四段都要对上：daemon 入队日志、处理器写 outbound 时间、daemon 发送日志、用户 QQ 端亲眼确认。
- **陌生人抽查**：白名单外 QQ 发消息，只进 `strangers.jsonl`，机器人不回复。
- **群聊**：只有用户要求时才做。未 @ 不入队（平台不推送）、@ 后入队并回复，两项都要真发消息验证；没测过就明说未测。
- **保活**：停掉 daemon 后，按所选保活方式（health hook 跑 `ops/start.sh`，或 systemd Restart）验证能拉起并恢复心跳；只说"已配置"不算通过，要有一次真实触发证据或明确标注未实测。
- **被动回复规则**：不要拿真实账号硬刷 5 条测上限——上限降级已由冒烟覆盖；真实验收只确认正常回复走被动通道即可。

### 5. QQ 侧边界

这条桥适合文字聊天与约定的轻量任务。浏览器画面、Muse 主界面的结构化审批、安全录入卡和钱包确认无法搬到 QQ；凡是付款、向外发信/发布、重要删除、高价值账号设置，不允许只凭一句 QQ"确认"就执行，要停下让用户回主界面完成。禁止向白名单外的人发主动消息；主动消息只作被动额度耗尽时对主人回复的降级通道。用户的轻量工作范围由用户自己的指令确定，桥接工作者不要替用户放大。

### 6. 日志与排错

只报脱敏事实：阶段（bind/connect/inbound/outbound）、带时区时间、进程 pid、心跳新鲜度、SDK 错误的简短原因。常见情况：发送失败先查 Markdown 权限与被动窗口是否过期；机器人搜不到先查可用范围/发布状态；群里没反应先确认是否 @；凭证无效（token 换取失败）立即停自动重试，请所有者重新扫码绑定，不要边猜边重启。完整细节看 `references/full-guide.md` 的排错表。

### 7. 交付报告

收尾时给状态矩阵，不只说"好了"：机器人身份（AppID）、绑定方式、进程与心跳、文字端到端、白名单与陌生人抽查、群聊是否已测、保活方式与实测情况、仍存在的上限（附件只记元数据、出站仅文字、整机恢复依赖本地凭证文件等）。每项都写证据来源（哪次日志、哪次用户确认），不要把 daemon 日志当成用户端收到的替代证据，也不要把冒烟通过说成真实连通已验收。

## Workflow

1. 审计现有部署 → 2. 向所有者确认绑定方式与平台侧准备 → 3. 安装模板并冒烟 → 4. 扫码绑定并启动 → 5. 逐项完成白名单、文字、陌生人、群聊、保活验收 → 6. 用状态矩阵交付，附上回到这里时该看哪份文件。完整细节在 `references/full-guide.md`，逐步打勾表在 `assets/template/CHECKLIST.md`，分步安装在 `assets/template/INSTALL.md`。

## Output Contract

每次用完这个 skill，至少交代：当前 QQ 机器人是谁（AppID）、跑在哪台机器/运行目录、凭证模式（local_file，不给值）、到目前为止哪几关已实际通过、哪几关未测或正被什么堵住、下一步需要用户在 QQ 或开放平台做的具体动作（如果还有）。
