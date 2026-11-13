# QQ 桥接开通清单

## 0. 开工审计
- [ ] 已确认不是重复部署：现有 bridge 目录、进程、hooks、cron/systemd 没有另一套正在跑。
- [ ] 已确认部署目标目录与当前 Agent 的工作区/hook 机制；非 Muse 环境已准备好等价的 inbox 轮询处理器。
- [ ] Node.js ≥ 20，本机能访问 `api.bot.qq.com` / `bots.qq.com`。

## 1. 机器人与平台（由所有者操作）
- [ ] 机器人已就绪：扫码绑定自动创建/绑定，或已在 https://q.qq.com 创建机器人应用。
- [ ] 机器人具备 Markdown 消息能力（后台确认；没有则回复会发送失败，需先在后台开通）。
- [ ] 可用范围/发布状态包含测试用户（所有者本人能搜到并私聊机器人）。
- [ ] 群聊可选：机器人已被拉进测试群，成员知道需 @ 机器人才有响应。

## 2. 凭证门禁
- [ ] 凭证经扫码在本机落盘，或由所有者在本机以环境变量方式提供手工模式；**没有经聊天传递 AppSecret**。
- [ ] `config/credentials.json` 权限 0600，已被 .gitignore 覆盖；值不进入 skill、代码、日志、命令参数或长期记忆。
- [ ] `node bridge/bind.mjs --check` 通过（appId/appSecret 均 set，只看长度不看值）。

## 3. 本地部署
- [ ] 已运行 skill 的 `bin/install_template.sh`（或手工等价复制）到运行目录。
- [ ] `npm install` 成功；`node --check bridge/*.mjs` 全部通过。
- [ ] `config/config.json` 只含非秘密字段；合并窗口、被动上限、主动降级开关符合预期。

## 4. 冒烟（不连网）
- [ ] `node bridge/smoke-test.mjs` 输出 `SMOKE RESULT: ALL PASS`。
- [ ] 冒烟覆盖：主人私聊入队、陌生人只记 strangers 不入队、群 @ 入队、被动回复挂对 msgId、第 5 条降级主动、chunker 代码围栏完整。

## 5. 保活启动
- [ ] 用 `ops/start.sh`（nohup+pidfile）或 systemd user unit 启动，二选一未叠加。
- [ ] `ops/status.sh`：进程在、心跳年龄 ≤ 120 秒、`connected=true`。
- [ ] 日志出现 `qq gateway ready`；报告连通时不复制任何 token/连接票据。

## 6. 文字端到端
- [ ] 所有者在 QQ 私聊机器人发一条约定测试文字。
- [ ] 追踪四段：daemon 入队日志、处理器写 outbound 时间、daemon 发送日志、所有者 QQ 端亲眼确认收到。
- [ ] 白名单已生效：所有者 openid 在 `ownerOpenId`/`allowedOpenIds` 内（扫码回填或从 strangers 认领后回填），再发一条验证直接入队。
- [ ] 陌生人抽查：换一个未加白名单的 QQ 发消息，只进 `queue/strangers.jsonl`，机器人不回复。

## 7. 群聊（用户要求时才做）
- [ ] 群里 @ 机器人发消息，入队并回复成功。
- [ ] 群里不 @ 时无反应（平台不推送，符合预期）。

## 8. 自动唤醒与健康恢复
- [ ] inbox hook 每 15 秒：空队列 dry-run 为 silent；假消息 dry-run 为 wake；假消息已清理后才启用。
- [ ] inbox hook 工作者只写 outbound/processed，不直连 QQ API，不找 AppSecret。
- [ ] health hook 每 60 秒：健康时 dry-run 为 silent；陈旧心跳 wake 分支已手工走读；启用后 30 分钟不重复唤醒。
- [ ] health 恢复路径实测或走读通过：停 daemon 后由 start.sh 拉起（或明确记录未实测）。
- [ ] 若当前 Agent 没有 hooks，已用等价轮询/任务系统替代，并同样验收空/有消息两种情况。

## 9. 收尾
- [ ] 报告状态矩阵：机器人身份（AppID 可报、秘密不报）、绑定方式、进程与心跳、白名单、文字端到端、群聊是否已测、保活方式、二期上限（附件下载/出站媒体/流式/按钮未实现）。
- [ ] 已说明 QQ 侧只承接所有者约定的轻量工作；付款、对外发送、重要删除仍回主界面确认。
- [ ] 已给出停止/回滚方法（`ops/stop.sh`）；未经所有者批准不删凭证与队列证据。
