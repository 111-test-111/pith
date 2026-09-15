# 原生子 Agent：第三轮 Review 修复交接

## 当前状态

- 用户要求在第三轮 Review 中直接修复发现的问题，随后因额度限制要求立即停止并留下计划。
- 分支：`feature/native-subagents`。开始本轮时 HEAD 为 `337fa68`。
- 本轮改动留在工作区，**未提交，未完成最终验证，不应直接合并**。
- 不要回滚这些改动，也不要根据之前 GLM 的“全部修复”报告判定已完成。
- 没有调用真实模型；测试使用临时目录、模拟 provider stream 和真实 Pi SDK。

## 已修改的内容（仍需最终验收）

### 1. Renderer roster

`src/renderer/src/state/pi-store.ts`：

- 修复切换到 B 会话时合并 A 会话子任务的串数据问题。
- 无 transcript sequence 的 `subagents_update` 可以在 snapshot/缓存激活后重放。
- 即使 snapshot 的 transcript 较旧，也独立合并较新的 roster。
- runtime 的 seq 改成进程内单调递增，避免重新创建父 ManagedSession 后 seq 重置。
- `recover()` 不再用磁盘记录覆盖已经收到实时更新的同一 child。

### 2. 聊天文件列表和 Review

`chat-turns.ts` 的 ChangeScope 新增 `completions`；ChatView/MessageItems 与 `extractReviewTurns()` 共用这份证据。

- 修复 Review 独立入口仍未传 completion 的遗漏。
- completion 经过用户 steer 后，文件列表迁移到 scope 最后一组时仍保留证据。
- 前台失败不再直接 throw 丢掉 details：`installSubagentResultHook()` 使用 SDK 的 afterToolCall 设置 isError，保留文件证据，并让已有 extension hook 正常处理。
- 文件聚合允许失败 agent 结果中的成功写入；普通失败 edit/write 仍不计入。

### 3. 生命周期与恢复

`src/main/pi/subagents/runtime.ts`：

- 先 reserve 再登记 starting/launching，防止达到并发上限时泄漏永不结束的启动 promise。
- completion 延后一微任务执行，确保先登记 LiveRun；修复启动前取消时同步完成、随后又把已结束 run 写回 registry 的问题。
- 所有路径清除订阅和定时器；异步 halt/release 完成前持续持有 lease。
- stopAll 超时抛错，不能在尚未停止时报告成功并允许调用者继续删除/导航。
- resume 在任何 await 前占有每-child 的 resuming 标记；单独停止某个 child 不再取消其他正在启动的 child。
- background drain 同时检查 child 的 idle 与待投递完成通知；空后台任务列表不再直接代表完成。
- token 统计改为累计。

`src/main/pi/manager.ts`：

- child 创建/恢复与普通 open 共用 sessionBuilds，避免并行创建同一文件的两个 ManagedSession。
- 复用检查 isIdle，并校验 child 的父身份。
- 句柄使用活 AgentSession 自己的 SessionManager。
- 恢复一个之前停止但仍打开的 child 时，恢复它的 TaskNotifications。
- release 可等待 dispose 完成。
- 只读 child 增加 model/thinking/fork 的 main 拦截，renderer 禁用相关输入和重试/编辑入口。

### 4. 每次运行的文件证据

新增向后兼容的协议字段/条目：

- 父会话 `pith_subagent_dispatch`：每次 start/resume 写入，记录 runId、child 路径和调用来源。
- child start 的 `parentDispatch: true`：表示该 run 必须通过选中的父分支上的 dispatch 归属。
- 结果 DTO 和持久化 result 的 `writtenFilesScope: 'run'`：新结果仅包含本次运行的成功写入。
- DiskSubagentRun 保存 start/result entry ID，用真实分支区间提取操作，避免把其他 resume 的写入借过来。
- coverage 按 checkpoint 后的父 dispatch 选择新 run；旧记录仍按父 agent 调用兼容。
- renderer 新记录按 runId 去重，旧累计记录按 child 去重。

这部分涉及数据契约，必须重点验收，不能只看类型通过。

## 当前测试状态

- 更新后的 `node scripts/check-subagents.mjs` 已通过。其创建期取消测试已改为外部 gate，不再在 createChildSession 内 await stopAll 造成自等待。
- 新增 `scripts/check-subagents-integration.mjs`，前三组已通过：
  1. roster 会话隔离、事件/snapshot 竞争和父实例重建；
  2. completion → scope → Review、失败写入和新旧结果去重；
  3. 并发拒绝、创建期取消、异步清理持锁、child 完成通知交接。
- 新脚本在真实 PiManager 的只读入口测试处失败：

  ```text
  TypeError: this.notifyError is not a function
  at PiManager.prompt
  ```

  原因：脚本用 `Object.create(PiManager.prototype)`，没有初始化构造函数中的 `notifyError` 字段。**先给该夹具补一个收集错误的 notifyError stub，再继续跑**。这是当前已知的测试阻塞点，不是已证实的产品入口故障。
- 尚未跑到新脚本中的真实 SDK serial resume、分支恢复、per-run coverage 和失败结果 hook 测试。
- 曾运行 typecheck，但随后继续修改了代码；**本轮最终 typecheck/build 和共享回归尚未完成**。

## 接手后的顺序

### A. 先让新增集成测试跑完

1. 读 git diff，保留当前未提交改动。
2. 补 `check-subagents-integration.mjs` 的 notifyError 夹具，不要绕开只读入口断言。
3. 运行 `node scripts/check-subagents-integration.mjs`，逐项修复后续实际失败。
4. 特别确认真实 SDK resume 后两个用户消息都在重新打开文件的 selected branch 上，而不只是存在于 JSONL 中。
5. 检查复用 child 的 isIdle/parent 检查是否需要在 await 后重验；并行 open 与 resume 必须只有一个 ManagedSession。

### B. 补完已经发现但未处理/未充分验证的边界

1. **父分支孤立的 resume**：当前 coverage 已忽略被 rewind 掉的 dispatch，但 runtime.resume 尚需校验所恢复的 run 是否属于当前父分支，防止继续一个已经被放弃的分支。
2. **终态持久化失败**：runtime 仍有 best-effort result append；不要在 result 未持久化时无提示地宣称成功。明确失败/恢复语义，并加故障注入测试。
3. **background drain**：新增逻辑目前只有 mock handoff 测试。补真实 SDK + BashTaskManager + TaskNotifications 测试，覆盖命令结束→steer→child 再运行→最终完成，以及 Stop 时通知不能重新唤醒。
4. **恢复与停止顺序**：rewindRestore 的 stopAll 仍在 withExclusive 内。持有运行 lease 时会在进入 callback 前返回 busy。核对既有“活跃任务阻止恢复”的产品契约，保持安全；不要为了能进入 stopAll 而提前释放 lease。
5. **失败写入与崩溃证据**：补 failed、aborted、无 terminal record、两个 resume、checkpoint 位于两次运行之间、父分支放弃旧 dispatch 的断言。
6. **只读 UI**：确认 Composer 的粘贴/附件/模型控制、聊天重试/fork/编辑入口与 main 围栏一致；不要修改 vendored beUI primitive。
7. **通知去重与 scope 归属**：同一 run 的 toolResult/notice 不重复计数；跨用户 steer 后聊天和 Review 一致；后台 completion 不成为普通助手卡片。

### C. 最终验证

按项目 AGENTS.md 执行；至少：

```bash
npm run typecheck
npm run build
node scripts/check-subagents.mjs
node scripts/check-subagents-integration.mjs
node scripts/check-bash-tasks.mjs
node scripts/check-bash-task-ui.mjs
node scripts/check-todos.mjs
node scripts/check-transcript-order.mjs
node scripts/check-rewind-sdk.mjs
node scripts/check-session-persistence.mjs
node scripts/check-session-lifecycle.mjs
```

按最终修改范围补 written-file-preview / rewind UI 检查。不要同时跑多个依赖画帧时序的 Electron 性能检查。

### D. 文档与交付

- 更新 `docs/subagents-implementation.md` 和 AGENTS.md 中的持久化、resume、文件归属、停止和验证说明，尤其将“所有新结果都是整个 child 的累计写入”改成实际的新旧协议。
- 明确真实模型 Electron E2E 是否执行；未执行就如实写明。
- 最终汇报按“发现的问题 → 修复 → 测试证据 → 剩余限制”组织。
- 当前未获单独的提交/合并指令；完成修复和验证后可保留工作区供用户审阅，不要自动合并。

## 本轮不要扩展的功能

暂不做新的模型查询/steer 工具、Profile 编辑器、MCP 扩展继承、worktree 隔离。先把现有实现的生命周期、分支证据和显示投影验证完整。
