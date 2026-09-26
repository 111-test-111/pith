# DAP：无源码调试、子代理视图与工具接口

调查时间：2026-09-27。以当前工作区代码和 Oh My Pi 提交
[`09dee778d6d321cc2957105a87742efe3b1b2ac2`](https://github.com/can1357/oh-my-pi/tree/09dee778d6d321cc2957105a87742efe3b1b2ac2)
为准。下文保留初次调查的缺口与方案，作为设计依据。

**实施更新（2026-09-27）：已完成 action registry、嵌套参数与旧格式兼容、DTO/source identity，
以及 LLDB 无源码闭环（虚拟源、反汇编、寄存器、内存、模块、函数/指令断点、指令单步与 core 只读检查）。
真实 LLDB 和真实 Electron/preload/IPC 联调均通过。** 当前契约、边界及验收脚本见
[实现文档](debug-implementation.md#action-registry-and-compatibility)。数据断点、写内存、远程 profile、
动态工具发现仍属于后续能力，不计入本次验收。

## 1. 无源码调试需要完整的地址工作流

初次调查时，后端可以调试二进制和加载 LLDB core，但数据模型与 UI 仍以本地源码为中心：

- `DebugManager.mapFrame` 只保留文件、行列和名称，丢失 `instructionPointerReference`、`moduleId` 和 `sourceReference`。
- `mapVariable` / `evaluate` 丢失 `memoryReference`；`scopes` 丢失 `presentationHint`，寄存器虽可作为普通 scope 展开，却没有稳定的语义标识。
- `DebugLocationDTO` 要求 `file + line`。面板打开本地路径，不能请求适配器提供的虚拟源。
- 断点只有源码行；控制没有 `granularity`；没有反汇编、内存、模块和数据断点操作。
- `DapClient` 保存初始化 capabilities，但 DTO 没有提供能力快照，manager 也没有统一的能力检查入口。
- core 当前有明确的只读限制，但它只放行 stack/scopes/variables，还不能读反汇编或内存。

需要区分三种场景，避免把“没有源码”和“没有符号”混为一谈：

| 场景 | 合理的体验 |
| --- | --- |
| 源码不在本地，符号仍在 | 优先 adapter 的 `sourceReference`，然后源码映射；函数名和可用变量继续显示 |
| stripped / 无调试符号 | 地址、模块、汇编、寄存器、内存成为主要定位手段；不承诺还原局部变量或源语言结构 |
| 优化构建或 core | 显示实际可得信息和缺失原因；core 禁止执行，但允许经过能力检查的只读内存、模块和反汇编 |

### 本机实测：适配器已经具备主要能力

使用 Apple `lldb-2103.0.34.103`，编译一个不带 `-g` 的临时 C 程序，执行 `strip`，
删除源文件，然后通过现有 `DapClient` 直接访问 DAP；程序在 `__builtin_debugtrap()` 处停止。
进程和临时文件均在实验后清理。

实际结果：

- 栈帧有 `instructionPointerReference` 和 `moduleId`，函数名为 LLDB 合成名称。
- `source` 有 `sourceReference: 1`，`path` 为 `probe\`___lldb_unnamed_symbol_…` 一类虚拟名称，并非磁盘文件。
- `disassemble` 成功返回 4 条 ARM64 指令及机器码；`readMemory` 成功读取 16 字节。
- `scopes` 返回 `presentationHint: "registers"`，可展开通用、浮点等寄存器组。
- `next(granularity: "instruction")` 实际停止于下一条指令，PC 从 `0x1000003CC` 到 `0x1000003D0`。
- 适配器还声明支持函数断点、指令断点、数据断点、模块查询和内存写入。
  **此次只验证了这些额外功能的 capability 声明，没有把它们计为真实操作通过。**

这说明首要问题是应用层没有贯通现有 DAP 信息。当前面板会把上面的虚拟 `path` 交给文件浏览器，
保留 `sourceReference` 并使用 `source` 请求才能正确打开。
协议明确要求：`sourceReference > 0` 时，即使带有 `path`，也应请求适配器内容。
参见 [DAP Source、StackFrame 和内存协议](https://github.com/microsoft/debug-adapter-protocol/blob/main/debugAdapterProtocol.json)。

### 推荐实施顺序

**第一步：保留身份与能力，不再要求每个停止点都有文件行号。**

- 在 shared DTO 中增加完整的 source identity、指令引用、模块 ID、变量内存引用、scope 提示和经过筛选的能力快照。
- source 分清本地文件和 adapter 虚拟源；虚拟内容通过独立的 typed IPC 获取，按 `debugId + sourceReference` 缓存，结束/失效事件清理。不得塞进磁盘文件缓存。
- 停止位置至少能表示“函数名 + 模块 + PC”；没有源码时仍有可以选择和导航的当前指令。
- 能力判定同时在 main 和 UI 生效；处理 DAP `capabilities` 更新，并结合当前状态和 core 限制。
  初始化只声明客户端真正实现的能力。

**第二步：实现可完成任务的最小闭环。**

`暂停 → 定位 PC → 反汇编 → 查看寄存器/内存 → 设置指令断点 → 按指令单步 → 再读取状态`。

| 操作 | DAP 与应用侧要求 |
| --- | --- |
| 反汇编 | `disassemble`；默认使用所选 frame 的指令引用；区分字节偏移与指令偏移；保留无效指令位置 |
| 内存读取 | `readMemory`；正确处理 base64、短读和 `unreadableBytes`，空洞不能补成零；建议初始上限 4 KiB/页 |
| 寄存器 | 优先 `scopes(presentationHint=registers) → variables`，无需另造通用 DAP registers 请求 |
| 指令单步 | `next/stepIn/stepOut` 的 `granularity=instruction`，先检查 `supportsSteppingGranularity` |
| 指令断点 | `setInstructionBreakpoints` 的完整集合替换；复用当前断点串行写入和权威状态，避免丢失其他断点 |
| 符号断点 | `setFunctionBreakpoints`，服务有符号但无源码的程序；仍有独立 capability 检查 |
| 模块与符号状态 | `modules` 分页；展示模块路径、地址范围和适配器返回的符号状态；源码映射与符号装载是不同问题 |

UI 的反汇编应成为可导航的常规视图，显示地址、机器码、指令、符号、当前 PC 和断点，
支持源码/汇编切换及虚拟源。寄存器、内存和模块在调试面板按需读取，沿用 beUI、i18n、
窗口化和有界缓存。寄存器变化只能在同一目标、线程与可比 frame 之间计算，不能把切换目标当成值变化。

所有 stop 相关句柄继续携带 `{debugId, stopId}`，在 await 后再次校验。地址和 memory reference
保留为字符串，不能转换成 JavaScript Number；适配器引用不保证就是可算术运算的十六进制地址。
显式地址运算需要精确整数处理，ASLR 下的原始地址不能直接在重启后重放。

**第三步：增强观察点和适配器差异支持。**

- 数据断点先 `dataBreakpointInfo` 再 `setDataBreakpoints`，遵循 access types、句柄生命周期和 `canPersist`；
  按地址/字节范围设置还需 `supportsDataBreakpointBytes`。不能跨停止、跨进程盲目复用旧 dataId。
- 将以上只读检查接到 core；继续拒绝控制、内存写入和可能执行代码的表达式。
- 符号搜索路径、source mapping、远程 attach 等通过适配器 profile / launch configuration 统一整理，
  根据模块身份校验二进制与符号匹配，避免扩张成更多平铺的启动字段。
- 原生 debugger 命令只作为有记录的适配器扩展；它不是默认“只读”，也不能绕过状态同步、core 和权限边界。

验收应包含：无源码有符号、真正 stripped 二进制、优化后的 unavailable 变量、虚拟汇编源、
core 缺页、内存短读、ASLR 重启、能力缺失、旧 stopId、多子代理并行目标。真实 adapter 和
协议 fixture 分开报告；缺失 adapter 只能计 SKIP。以 LLDB 先完成全闭环，再扩展其他 native adapter。

## 2. 已接入子代理调试视图

调试面板使用当前聊天的 `PiStore.subagents` roster 加上父会话路径作为显示范围：

- 一个 beUI 目标选择器显示当前聊天和子代理目标，子代理带 profile 与任务描述；
  DAP 的 `parentId` 子目标仍保留独立标签，不和“子代理”混淆。
- 首次挂载、切换聊天或 roster 成员变化时，按 owner 拉取 `debugList`，恢复此前漏掉的事件；
  tokens/进度刷新不重复请求列表。同时挂载的面板与文件视图合并正在进行的读取。
- 目标选择按所查看的聊天保存，详情、监视与断点操作携带目标自身的 `sessionPath + debugId`。
  `useDebugTargets` 让调试面板与源码 gutter 使用同一选择。
- 子代理结束后保留所选目标及有界输出；重启替换会话跟随 `replacesId`，并迁移监视表达式；
  用户已选别的目标时不抢回选择。切换聊天或移除 roster 成员不会显示缓存中的无关目标。
- 这只是人类视图的聚合。没有打开/激活子代理聊天，没有改工具入口、角色授权、main 的 owner 校验或运行清理。
  父模型和兄弟模型仍不能访问该子代理的 debugger。

相关实现：`use-debug-targets.ts`、`debug-store.ts`、`DebugPane.tsx`、`FilesPane.tsx`。
`check-debug-ui.mjs` 增加了 owner 路由、真实 FilesPane gutter、漏事件恢复、roster 变化、
无父 debugger、退出、重启、聊天切换和中英文显示回归。

## 3. 参数增长：先拆协议定义，再解决模型上下文成本

当前 `debug` 是 action 加大量顶层 optional 字段。它允许无意义的组合，而且字段是否必填
主要靠 `execute` 的各个分支补判定。下一轮增加 memory、disassembly 和 watchpoint 时，
继续往这里追加字段会放大维护成本。

建议保留一个外部 `debug` 入口，先改为**公共目标信封 + 按 action 区分的 request**：

```json
{
  "debugId": "…",
  "stopId": 7,
  "request": {
    "action": "memory.read",
    "memoryReference": "0x1000003CC",
    "count": 256
  }
}
```

这是接口草案，不是当前可调用格式。`request` 使用带 literal action 的判别联合，
不是 `Record<string, unknown>`。外层保持 object，避免直接用根级 union；仍须实际验证所支持
provider 对嵌套 union / constrained sampling 的兼容性。启动参数只属于 `session.start`；
步进粒度只属于 `execution.step`；内存参数只属于 memory action。公共 sandbox 参数仍在信封中。

建立一个 app-owned action registry，每项集中声明：

- 参数 schema 与简短用法；
- 需要的 target/stop/frame 和 adapter capability；
- 执行权限、core 是否允许、串行/状态失效策略；
- 返回类型、分页上限和 handler。

同一份 registry 生成工具 schema、按 action 的帮助和校验，减少重复 switch 中的漂移。
断点输入改为 `items: [{line, condition, hitCondition, logMessage}]`，消除多组平行数组。
旧格式可利用当前 Pi SDK `ToolDefinition.prepareArguments` 在校验前规范化到新结构；
禁止新旧格式混用，公开 schema 只描述新结构，避免兼容层本身继续膨胀。

**嵌套参数和拆成多个工具都不自动减少总 schema token。** 应分别衡量 schema 大小、非法参数率、
每次调试所需调用数和往返耗时。短说明常驻，详细步骤与 adapter 差异放进按需 help；
先解决结构，再决定是否建设真正的工具发现机制。

若工具上下文成本仍明显，第二阶段可按 session/control/breakpoints/inspect/memory 分成少量工具族，
通过发现入口按需加载，而不是一次暴露几十个 DAP 请求。当前安装的 Pi 0.85.x
`ToolDefinition` 没有 OMP 的 `loadMode: "discoverable"`；复制该属性不会产生懒加载。
主机必须自己实现发现/激活，并同步 catalog、`APP_DEBUG_TOOL_NAMES`、Settings 的 debug 开关、
Plan gate 定义身份及子代理冻结 ceiling。发现只能揭示已授权能力，不能扩大权限。

不建议用任意 `custom_request(command, arguments)` 代替这套类型：它让模型承担 DAP 状态机，
也容易绕开 stop 校验、capability、断点缓存和清理纪律。若保留逃生口，应单独标为执行能力，
限制可调用命令并明确缓存失效；正常能力走经过管理的 action。

## 4. Oh My Pi 中适合借鉴的部分

以下是当前源码调查，未运行 OMP 本体；本机的实测使用 pi-app 的 DAP transport。

| OMP 做法 | 对 pi-app 的价值与限制 |
| --- | --- |
| 工具层 → `DapSessionManager` → `DapClient` → adapter config | 分层与本应用接近，可以移植单项能力，不需要整体替换后端 |
| 反汇编默认取 stop 的 instruction pointer；已有内存、模块、指令/函数/数据断点 | 可以直接参考请求构造与结果字段；移植时增加现有 stopId 校验、分页及本应用边界 |
| 反汇编/内存等请求前 `requireCapability`，read/exec 分级 | 值得集中到 action registry；检查同时放在 main，不能仅由工具层负责 |
| 可发现加载与按动作生成可读结果 | 借鉴减少常驻说明及原始 JSON 噪声的思路；Pi SDK 需要额外主机支持 |
| 默认 adapter 描述与配置覆盖、按扩展名/项目标记选 adapter | 可增强现有 adapter registry 和配置入口；保留显式选择与探测失败诊断 |

出处：[工具 schema、capability 与发现标记](https://github.com/can1357/oh-my-pi/blob/09dee778d6d321cc2957105a87742efe3b1b2ac2/packages/coding-agent/src/tools/debug.ts#L57-L140)、
[DAP session 操作](https://github.com/can1357/oh-my-pi/blob/09dee778d6d321cc2957105a87742efe3b1b2ac2/packages/coding-agent/src/dap/session.ts#L655-L930)、
[adapter 配置](https://github.com/can1357/oh-my-pi/blob/09dee778d6d321cc2957105a87742efe3b1b2ac2/packages/coding-agent/src/dap/config.ts)、
[协议类型](https://github.com/can1357/oh-my-pi/blob/09dee778d6d321cc2957105a87742efe3b1b2ac2/packages/coding-agent/src/dap/types.ts)。

有三个不宜照搬的点：

1. OMP 的 manager 是导出的单例，`#ensureLaunchSlot` 限制一个活动 root，目标操作依赖 active session。
   它的 DAP child tree 不能替代本应用“每聊天、每子代理、每目标”的 ownership。
2. OMP 的 `debugSchema` 同样平铺了大量 optional 参数，未解决这里的参数问题。
3. OMP 虽然在类型中定义了 stepping granularity，但当前工具没有对应参数，`#step` 只发送 threadId；
   指令级单步不能仅复制类型或宣称其已经贯通。

出处：[单 root 限制](https://github.com/can1357/oh-my-pi/blob/09dee778d6d321cc2957105a87742efe3b1b2ac2/packages/coding-agent/src/dap/session.ts#L1323-L1332)、
[实际步进请求](https://github.com/can1357/oh-my-pi/blob/09dee778d6d321cc2957105a87742efe3b1b2ac2/packages/coding-agent/src/dap/session.ts#L1565-L1575)。

下一轮建议先完成 action registry 与 DTO/source identity，再按第二步的 LLDB 闭环开发和验收；
adapter 数量、任意原生命令和动态工具发现可以后置。

## 本次验证

`npm run typecheck`、`npm run build`、`check-debug-protocol.mjs`、`check-debug-ui.mjs`、
`check-debug-sessions.mjs`、`check-debug.mjs` 和 `check-file-browser.mjs` 均通过。
四个 adapter（LLDB、debugpy、Delve、js-debug）都执行了真实 fixture，未计入任何 adapter SKIP；
LLDB core 生成与读取也通过。新增子代理视图使用模拟 DAP DTO 的真实 Electron/beUI UI 回归，
没有把它表述为一次真实模型委派。320px 侧栏的英文浅色和中文深色截图已检查。
`PI_DEBUG_SCREENSHOT_DIR` 可保留 UI 回归截图。
