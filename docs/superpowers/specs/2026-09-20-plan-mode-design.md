# Plan Mode：DSH 只读规划、会话内计划与显式批准

- **状态：**设计方向已获用户同意；本文待书面评审，尚未进入实现。
- **调研基线：**pi-app `63e2ce9`；仅静态阅读本地源码与官方文档，未动态测试参考产品。
- **已确认：**运行时限制而非仅提示；复用现有 DSH；会话内计划卡片；批准后在同一会话执行；计划文件仅按需导出。

## 1. 目标与边界

Plan Mode 让模型只进行调查、澄清与设计，交付一份关键决策完整、可执行的 Markdown 计划。模型提交计划不等于用户批准，用户批准也不等于取得更大的文件权限。

### 必须保证

1. Plan 下，应用拥有的文件修改工具不可用；模型 shell 固定使用 DSH `read-only`，不能申请一次性提权。
2. 未适配的 MCP、任意代码执行工具、浏览器动作工具与未知扩展工具不对模型开放，并在执行入口拦截。
3. 主代理、子代理及旧子代理恢复不能绕过当前 Plan 限制。
4. 完整计划由主进程接收并随会话分支持久化，不要求模型写计划文件。
5. 批准绑定当前分支的指定计划版本；重复、过期或跨分支批准不能启动错误的执行。
6. 重开、压缩、reload、fork、rewind 不丢失模式与计划；恢复不自动重新执行已批准的任务。

### 只读的准确含义

这是**受管理模型工具的本地文件写入约束**，不是整个桌面应用的零写入环境。应用仍正常写会话、任务日志及必要的受信任索引缓存；用户主动导出计划也允许写入。模型没有这些宿主写入通道的任意路径或任意代码能力。

现有 DSH 不隔离网络，不能阻止 shell 调用远程写 API。因此第一版不承诺远程服务或数据库的强制只读；提示词禁止此类副作用，专门的联网能力仅开放经过审核的搜索/抓取工具。用户终端、同目录的其他会话、外部编辑器也不受本会话 Plan 约束。

扩展属于受信任宿主代码。工具过滤不等于隔离恶意扩展的 Node.js 工厂、生命周期 hook 或磁盘访问。不得以 Plan Mode 宣称已经建立不受信任插件沙箱。

### 不做

- 新的 OS 沙箱、shell 正则安全解析器、网络隔离或远程 API 审批框架。
- 自动进入 Plan、模型自行退出 Plan、自动批准。
- 清空上下文后执行、新会话执行、计划富文本编辑器。
- 自动写入项目文档、自动提交 Git、专门的计划文件写入豁免。
- 用计划卡片替换 Todo，或引入新的测试/UI 框架。

## 2. 现有接点

- [PiManager](../../../src/main/pi/manager.ts) 拥有会话、初始化、reload、工具集、子代理与 IPC 快照。
- [sandbox/mode.ts](../../../src/main/sandbox/mode.ts) 已从选中分支恢复 `pith_sandbox_mode`；[sandbox/local.ts](../../../src/main/sandbox/local.ts) 提供 DSH 后端。
- [file-tools.ts](../../../src/main/pi/file-tools.ts) 与 [bash-tools.ts](../../../src/main/pi/bash-tools.ts) 使用每次调用读取的沙箱模式，并支持一次性提权。
- [TodoState](../../../src/main/pi/todo.ts) 展示成功工具结果如何形成分支投影、跨压缩恢复并注入请求上下文。
- [subagents](../../../src/main/pi/subagents/) 已有冻结工具上限、每次运行的持久化、父消息通知、关闭屏障。
- [Composer](../../../src/renderer/src/components/app/Composer.tsx) 已有沙箱选择与只读子会话展示；新增工作模式不能混用其禁止输入的 `readOnly` 属性。

新状态须通过 [shared/types.ts](../../../src/shared/types.ts)、[main/ipc.ts](../../../src/main/ipc.ts)、[preload/index.ts](../../../src/preload/index.ts) 到 Renderer，不能绕开进程边界。

## 3. 工作模式与权限分离

```ts
type SessionMode = 'normal' | 'plan'
```

`SessionMode` 不加入 `SandboxMode` 枚举。现有会话 `sandboxMode` 保留用户选择；Plan 只覆盖实际生效值，不改全局默认，也不把恢复原权限解释为 `danger-full-access`。

```text
effectiveSandbox = planRestricted ? read-only : existingSandboxResolution
activeTools = enabledTools ∩ roleCeiling ∩ modeCeiling
```

`planRestricted` 在根会话取当前工作模式，在子会话取「该运行冻结的 Plan 限制 OR 父会话当前 Plan」。只读降级永远不能被子代理配置覆盖。

### 模式持久化

新增 `pith_plan_mode` 版本化 custom entry，包含工作模式和 `planId`。每次由 normal 进入 Plan 生成新的 `planId`；普通退出后重新进入是一轮新的规划，而非静默复用旧计划的批准权限。

从完整选中分支折叠恢复，缺少记录的旧会话默认 normal。不得从全会话 `getEntries()` 的其他分支取最新模式，也不得仅从压缩后的 `session.messages` 恢复。无法解释的 Plan 协议版本不得产生可执行批准；显式显示不兼容状态并保持受限。

fork 继承分叉点之前的模式与计划，但批准动作必须携带 fork 自己的会话路径。复制历史批准记录不触发执行。

### 切换的准入条件

第一版仅在以下状态全部满足时进入、退出或批准：

- 会话初始化完毕、未关闭、无 rewind/recovery 或模式转换占用。
- SDK 已真正 idle；不能用 `agent_end` 或单独的 `isStreaming === false` 代替。
- 会话及其子代理没有运行中/启动中的 bash、子代理或待投递的自动续接。
- 无待处理的结构化问题、提权请求、用户 steering/follow-up 队列。

所有入口使用同一个主进程准入检查与会话级转换锁。检查、保存和应用模式之间不能让新任务插入。拒绝时保持原模式和队列，不暗中停止任务或丢弃用户输入。UI 显示具体阻塞原因。

不试图追溯降权已经运行的 OS 进程；用户可先停止或等待任务，再切换。别的会话和用户终端不阻塞本会话切换，也不属于只读承诺。

## 4. 工具边界

### 初始允许集合

| 类别 | Plan 允许范围 |
| --- | --- |
| 文件调查 | 受信任的 `read`、`grep`、`find`、`ls` 实现 |
| shell | 应用拥有的 `bash`，强制 DSH read-only；`bash_task` 仅操作当前会话拥有的任务 |
| 工作流 | `ask_user_question`、`todo_write`、根会话 `submit_plan` |
| 子代理 | `agent`、`agent_steer`，继续遵循开关与角色约束；子会话可有 `message_parent`，不可再次派发或提交父计划 |
| 外部调查 | 已审核来源的 `web_search`、`web_fetch`，仅在用户原本启用时开放 |

第一版不开放通用 `mcp`/`mcpScript`/命名空间代理、`ctx_execute`/`ctx_execute_file` 等代码解释器、浏览器工具，以及其他未登记的扩展工具。不要按 `read*`、`web_*` 等名称前缀推断安全，也不能仅因同名就信任一个覆盖了内置工具的扩展。

使用小型、显式的能力/来源登记表，不建设通用插件权限平台。未知工具默认拒绝；必要宿主缓存写入只属于已审核实现的内部行为，不开放为模型能力。已有扩展覆盖同名读取/搜索工具时，必须审核该具体实现或提供 app-owned 安全读取实现；不能为了保持名称可用而静默放行覆盖者。

### 两层执行约束

1. `applyActiveTools` 统一计算可见工具；启动、动态工具变化、reload、模式转换与分支恢复都应用同一规则。
2. 应用拥有、不能从 Settings 关闭的执行 gate，在实际调用前重新检查当前模式与工具来源。工具被重新激活或模型引用旧 schema 时也必须拒绝。

对 app-owned bash/file 操作仍保留每次副作用时的 DSH 检查。Plan 状态下，`sandbox_permissions` 无论如何填写都不能打开提权窗口。错误明确告知当前处于 Plan，可继续调查或等待用户退出；不建议修改设置或换一个工具绕过。

工具约束必须覆盖 SDK 动态注册/延迟加载路径。实施时用当前安装 SDK 的实际调用链验证 gate，并用行为测试确认，不能只断言提示词或工具名称列表。

无可用 DSH 后端，或后端只提供 partial enforcement 时，不运行 Plan shell，也不回退到宿主执行；文件读取与计划生成仍可用。使用现有 DSH 后端状态说明能力限制。

## 5. 模型指导

增加应用内隐藏的 Plan 上下文扩展，不修改用户全局 `APPEND_SYSTEM.md`，不污染持久化的用户消息。

- 在每次 provider 请求的有效上下文中反映当前模式，覆盖子代理/后台消息唤醒、自动重试、压缩和 reload。
- 优先使用正式的 system prompt hook；若需要 `context` 补齐唤醒路径，使用应用拥有的类型化标记，不能扫描任意历史文本中的 magic string 决定跳过注入。
- 普通模式不保留失效的 Plan 指令；在 Plan 中用户说“直接实现”仍不能让模型自行转模式，模型应说明需要使用批准或退出入口。
- 指令中的工具可用性从实际 active tools 派生，而不是 `getAllTools()`。计划及面向用户的解释跟随用户语言。
- 对与当前模式冲突的 skill 工作流，保留调查/设计部分，把写文件、安装、提交等动作放进未来计划，不现在执行。

规划顺序：先阅读相关实现及项目规则；再用 `ask_user_question` 澄清无法从仓库获得的重要决策；汇总证据与取舍；提交完整计划。不要把可检索的事实反问用户。

完整计划默认包含目标/非目标、具体改动及文件边界、接口/数据流、异常处理、适用时的兼容迁移、实施顺序、测试验收和明确假设。内容随任务规模调整；不能用固定字数、标题数量或机器校验冒充语义完整性。

Todo 可记录调研过程，不代表实施授权。提交前必须汇总本次调查结果，不能把仍在运行的任务当作完成。

## 6. 计划提交与版本

新增 app-owned、sequential 的 `submit_plan({ plan: string })`。模型只提供完整 Markdown，不提供计划 ID、版本、路径或批准状态。

主进程生成的成功结果 `details` 包含版本化协议、`planId`、单调递增 `revision`、正文与正文 hash。统一规范化仅包括首尾空白和换行形式；hash 必须对应 UI 展示与执行使用的同一正文。正文设 128 KiB UTF-8 上限，超限返回明确错误，不能截断后保存。

计划投影仅接纳**已经持久化的成功 toolResult**，以其条目 ID 作为来源。执行中的参数流、失败结果、普通 assistant 文本都不是可批准计划。成功结果是权威正文，避免额外 sidecar 或重复存储导致不一致。

提交要求根会话处于 Plan、规划身份匹配、没有未结束的 bash/子代理、未回答问题或未消费的结果交付。工具执行时的检查不要求 SDK idle——它本身正处于一个工具调用内。

### 提交后的停止纪律

- 每次规划用户轮次最多一个成功提交；修订必须发生在新的用户轮次，失败提交可修正后重试。
- 拒绝 `submit_plan` 与其他工具在同一个 assistant 工具批次混用，避免“交卷同时又启动调查”的竞争。
- 返回 SDK 支持的 `terminate: true`，并由运行时提交锁拒绝该规划轮次之后的新工具活动。不能把 `sequential` 或 `terminate` 当作自动解决所有同批/续接问题。
- 卡片等待完整成功结果出现；只有会话真正 settled 且没有待续接工作时才能批准。模型在普通文字中交了一份计划但没调用工具时，按普通回复展示，不伪装成正式提交，不自动无限追问。

### 修订与恢复

一个 `planId` 可有多次 revision，每次都是完整替代版本，历史版本保留但不可批准。进入新的规划用户轮次后，上一次提交暂时失去可批准资格；本轮须重新提交完整版本，即使只是澄清后正文不变。这避免用户已提出修改而旧稿仍可一键执行。

压缩不清除计划。重新打开的会话可展示最新提交，是否可批准由选中分支、后续用户轮次、模式与运行状态共同决定。中断或失败不凭空生成新计划。

## 7. 用户批准与执行启动

批准是显式主进程动作，不是模型工具，也不是对用户“不错”“继续”之类文本做正则识别。IPC 请求携带 `sessionPath + planId + revision + submissionEntryId`；服务端验证选中分支与最新资格，自己读取正文及 hash。

第一版开始执行恢复原 `sandboxMode`。原选择是 read-only 时，执行仍保持 read-only；批准不隐含提升权限，UI 在按钮旁明确显示执行将使用的权限。

### 批准生命周期

新增持久化批准记录，包含唯一 `approvalId`、计划身份/hash，以及 `requested / started / failed / interrupted` 状态。会话级转换锁保证两次点击只产生一次执行启动。

1. 在锁内复核最新计划、分支、权限和 idle 条件，保存批准意图。
2. 暂时关闭其他 prompt、任务唤醒、模式/队列变更的准入，仅允许这一批准的启动流程。
3. 恢复普通模式的有效权限和工具，向**同一会话**提交明确的用户执行请求，携带权威完整计划及批准关联。执行请求必须沿用正常用户 turn 的 checkpoint、持久化和停止路径，不绕开 Rewind。
4. 在第一项执行工具获准前，必须保存启动关联和接受状态。批准意图、执行开场与 started 的关联用应用持久化身份建立，不通过扫描任意用户正文识别。
5. 解锁，显示执行状态。模型根据批准计划实施，遇到新证据或实质性变更仍应询问用户。

SDK 调用不是数据库事务，不能把“写模式记录 + fire-and-forget prompt”当作可靠事务：

- 批准意图保存失败：不切换、不启动。
- 启动在执行请求被接受前失败：恢复 Plan 限制，保存失败信息，卡片显示可重试。
- 请求被接受后发生模型/API/工具错误：保留一次真实执行及其错误，不自动再次提交整份计划；按普通会话重试/停止流程处理。
- 崩溃恢复发现批准或启动状态不完整：标为 interrupted，关闭自动执行与写入准入，要求用户显式处理；绝不仅因为有批准记录就重放执行。
- 已 started 的相同 `approvalId` 再次请求只返回当前状态，不重复启动。已失败且确认未启动的重试生成新尝试身份。

普通退出 Plan 只改变模式，不生成执行请求，不消费一份计划的批准。已退出规划留下的历史卡片没有“立即执行”能力；重新进入规划后需正式提交当前版本。

## 8. 子代理和后台任务

继续使用 pi-app 的托管子会话与通知机制，不复制另一套 runtime。

- 新派发工具上限 = 角色配置 ∩ 父实际可用工具 ∩ Plan 上限，排除递归派发和 `submit_plan`。
- 在每次运行的冻结资源快照中持久化 `planRestricted`，恢复必须保留。Plan 子代理在父退出 Plan 后也不能扩大权限。
- 继续已结束子代理时，重新校验当前父模式与工具集合；旧运行的冻结权限只可进一步收窄，不能因为复用 wrapper 跳过限制。必须覆盖 tool 入口、UI/API 恢复入口和冷重开路径。
- 子代理上下文说明只交付调查结果，由父代理提交最终计划；不能只依赖角色名 `explore`。

第一版保留现有后台并行调研，不偷偷把 `run_in_background` 改成前台。只读 bash 也可由现有任务管理器转后台。`submit_plan` 及批准都必须等待活动任务结束且结果交付已进入父上下文。结果尚未到齐时拒绝交卷，并继续使用现有受管理通知唤醒规划。

停止/Esc、rewind、删除和退出复用原有通知暂停与进程树清理，不能让迟到结果绕过模式边界自动启动实现。

## 9. UI 与协议

### Composer

新增 `Normal / Plan` 工作模式选择器，与现有沙箱权限选择分开。Plan 中仍可输入调查请求和修订意见，不能把整个 composer 设为只读。沙箱位置显示“Plan 强制只读”及原权限信息，Plan 中不能直接修改底层会话权限；退出后用户可重新选择。

模式切换只在主进程允许时可用。`/plan` 作为同一主进程动作的应用命令入口，不向模型发送一段模拟模式切换文本。第一版不增加新的全局快捷键。

### 计划卡片

使用 beUI app-level composition 和现有 Markdown。卡片位于提交轮次的主要回答位置，不能作为普通过程工具被最终折叠隐藏，也不能在正文、工具结果与侧栏重复打印整份计划。

- 显示版本、当前/历史/已批准/启动失败等状态。
- “开始执行”：仅最新有效版本、Plan 且满足 idle/准入条件时启用。
- “修改计划”：聚焦 composer 并提示输入修改意见，不创建空白修订、不自行启动模型。
- “复制 / 导出”：所有已保存版本可用；导出由主进程校验版本、读取权威正文并通过原生 Save As 选择路径。取消对话框不改变计划。
- 历史卡片保留内容及复制/导出；失效动作不可点击。

新 UI 全部使用 beUI、主题 token 和双语 i18n。主进程返回错误代码及参数，Renderer 负责用户文案。

### 同步

`SessionSnapshotDTO` 带工作模式、配置/实际沙箱模式、最新计划元数据、转换/批准状态与能力限制。完整正文通过成功提交消息或按 ID 的有界读取获得，状态更新不重复广播大段正文。

新增 sequence-free `plan_state_update` 元数据事件，遵守现有 sandbox/ask-user/subagent 的快照重建规则；不伪造 `eventSequence`。后台任务或待处理问题改变时，也须重新派生可批准状态。

## 10. 模块划分

新增模块建议集中在 [src/main/pi](../../../src/main/pi/)：

- `plan-mode.ts`：纯模式/权限规则与分支折叠。
- `plan-context.ts`：隐藏上下文扩展和模型指令，不持有 UI。
- `plan-submission.ts`：工具 schema、结果协议、版本及计划投影。
- `plan-approval.ts`：批准准入、幂等尝试、持久化状态与恢复。

PiManager 负责生命周期接线；DSH 只负责现有文件效果约束。不要继续把全部业务塞进 manager，也不要为本特性重构无关会话逻辑。

Renderer 新增模式选择器和计划卡片；扩展现有 message/store/tool 图标与分类，而不是建立第二套消息列表。共享进程协议仍从 shared/types 导出；测试所需的纯协议不得依赖 Electron。

## 11. 验证与验收

使用现有 `scripts/check-*.mjs` 风格，先增加失败用例，再实现对应行为。

### 纯状态/协议

- 默认 normal；进入/退出/再进入；配置权限不被覆盖。
- revision、同轮重复提交、空/超长正文、失败 toolResult、hash 与正文一致。
- 选中分支折叠、fork、压缩后恢复、旧版本/跨分支批准拒绝。
- 重复批准幂等、各阶段失败与中断恢复、不重放历史执行。

### 真实运行时

- 在用户原权限为 full access 时，Plan 的 edit/write、shell 写工作区/外部/临时目录仍失败；`/dev/null` 等 DSH 必需例外保持原语义。
- shell 重定向、管道、命令替换、解释器写文件和符号链接路径不能逃出文件只读约束。
- Plan 提权不产生批准请求；不可用/partial 沙箱不运行 shell，不回退。
- 未适配工具、同名覆盖、动态注册、reload、旧 schema 调用不能越过 gate。
- 验证本模式不声称隔离网络；测试不访问或修改真实远程业务系统。
- 活动任务阻止切换；模式切换/任务创建竞争由同一准入约束阻止。
- 新子代理、旧子代理继续、冷恢复及父退出后均保持正确上限。
- 提交与其他工具混批被拒绝，未汇总后台结果不能交卷，`agent_end` 不提前开放批准。
- 批准执行开场仍建立正常用户 turn 的 Rewind checkpoint；失败可观察、不重复执行。

### UI 与回归

- 两种 UI 风格、明暗主题、中英文；busy、初始化、阻塞原因与只读子会话展示。
- 卡片不会被过程折叠吞掉；修订、过期批准、启动失败、复制/导出与会话切换。
- Snapshot 与事件先后顺序不同不丢模式或计划。
- 执行 `npm run typecheck && npm run build`；新增 Plan checks，以及 sandbox、todos、ask-user、subagents、session-lifecycle、rewind 与相关消息/队列回归。

本文阶段不运行构建或声称功能已通过测试；实现完成后报告实际执行的检查和平台限制。

## 12. 参考与刻意不移植的部分

- [Codex plan prompt](https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/plan.md)：研究优先、决策完整、修订完整替代；其允许构建产物的语义不作为我们的 DSH 策略。
- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)：显式批准流程；不继承 bypass 场景下 Plan 不阻止写入的例外。
- [native-subagents plan-mode](/Users/jcy/workspace/pi-web-worktrees/native-subagents/lib/plan-mode.ts)、[plan-mode-extension](/Users/jcy/workspace/pi-web-worktrees/native-subagents/lib/plan-mode-extension.ts)、[批准路径](/Users/jcy/workspace/pi-web-worktrees/native-subagents/lib/rpc-manager.ts:1924)：借鉴 overlay、提交工具与工具交集；不复制仅校验客户端非空正文的批准、非事务唤醒、任意文本 marker 去重和旧子代理恢复缺口。
- [Pi structured-output example](../../../node_modules/@earendil-works/pi-coding-agent/examples/extensions/structured-output.ts)：使用 `terminate: true`，但额外处理同批工具与续接，并遵守 `agent_settled` 语义。

外部引用是调研时的浮动官方文档/源码；Claude Code 的闭源内部机制未经源码验证。本地参考工作树有未提交修改，调研未改动它。
