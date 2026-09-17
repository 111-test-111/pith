# 内嵌浏览器（Embedded Browser）移植设计 —— pi-app

> 来源：pi-web worktree `native-subagents`（webview 统一架构，2026-08-20 unification 之后的状态）。
> 本文档是 pi-app 移植的设计基线；实测铁律见 §11，任何实现改动不得违反。
> 参考实现的权威文档：pi-web `docs/architecture/embedded-browser.md`（领域规格）、
> `docs/superpowers/plans/2026-08-20-browser-webview-unification.md`（迁移计划）。
> pi-web 根目录 `browser-architecture.md` 是**废弃的 screencast 方案的事后剖析**，不是现状。

## 0. 已确认的决策

| 决策点 | 结论 |
|---|---|
| UI 位置 | 右栏面板（替换 `SIDEBAR_TABS` 现有 `browser` 占位符，与 Files/Terminal/Context 并列） |
| Agent 工具门控 | Settings 开关（`browserAgentToolsEnabled`，默认**关**）+ 一次性 consent（首次使用） |
| 批注模式 | 本次完整移植（捕获层、双坐标系、滚轮转发） |
| 服务层位置 | **方案 A**：BrowserService 进驻 Electron 主进程（无 HTTP 层、无独立进程） |
| 调试端口 | 每次启动常开：随机 19000–38999，仅 127.0.0.1，`PITH_CDP_PORT` 可覆盖（测试用） |
| 浏览 profile | 独立分区 `persist:pith-browser`（human 与 agent 页共享登录态——这正是 consent 的告知点） |
| UI 规范 | beUI 原生组件 + 主题 token + 双语 i18n + 无滚动条 + 圆角策略 + 方形 Checkbox 开关 |

## 1. 目标与非目标

**目标**：pi-app 获得与 pi-web 同构的内嵌浏览器——
1. 右栏浏览器面板：多页面（human + agent 页同栏）、地址栏/历史/前进后退、缩放、页内查找、打印、设备模拟、起始页与最近打开、清除数据、批注模式；
2. 13 个 `browser_*` agent 工具（aria snapshot + ref 交互模型，playwright-mcp 同源），驱动与用户**同一个** webview guest；
3. 聊天 http(s) 链接可选内置打开；
4. 状态同步从 2.5s 轮询改为事件推送（改进项，见 §12）。

**非目标（明确不移植）**：
- pi-web 的 `lib/browser-notifications.ts`（Web 通知设施，属会话通知域，非浏览器域）；
- web 模式占位分支与 `BrowserUnavailableError` 的 web 语义（pi-app 恒为 Electron 桌面形态，端口常开）；
- Next.js HTTP 路由层与 `BROWSER_SERVICE_VERSION` 热重载守卫（main 无 HMR）；
- pi-web 的 UI 级缩放（`setZoomFactor`/webFrame）——pi-app 无全局 UI 缩放设置，`uiScale` 恒为 1（保留 `effectiveWebviewZoom` 纯函数以便测试与未来接入）。

## 2. 核心架构（与参考实现同构，宿主不同）

```
┌──────────────────────────── Electron main ────────────────────────────┐
│ 启动（ready 前）：appendSwitch remote-debugging-port=<rand> +           │
│                   remote-allow-origins=http://127.0.0.1                │
│ BrowserWindow: webviewTag: true（其余 webPreferences 不变）             │
│                                                                        │
│ src/main/browser/service.ts   BrowserService 单例                       │
│   playwright-core chromium.connectOverCDP("http://127.0.0.1:<port>")   │
│   → contexts()[0]（guest target 以 Page 形态浮现于此）                   │
│   reconcile 1s 轮询：marker 登记 / 消失注销 / url+title 刷新             │
│   agent 动作：goto / ariaSnapshot(mode:"ai") / locator("aria-ref=eN")   │
│   pendingCreate 握手 + closingTargetIds 宽限 + pendingNavigate          │
│ wiring.ts（web-contents-created 安装）：                                 │
│   弹窗路由（per-contents setWindowOpenHandler）                          │
│   input-event 中继（进程内直调 bumpInteraction，300ms/contents 节流）    │
│   browser 分区 will-download（自动存 ~/Downloads 去重）                  │
│   browser 分区 setPermissionRequestHandler（敏感权限默认拒）             │
└──────────────┬─────────────────────────────────────┬──────────────────┘
               │ browser:* IPC（typed）               │ browser:state / browser:popup
               │                                     │ 事件（无 eventSequence）
┌──────────────▼─────────────────────────────────────▼──────────────────┐
│ renderer：BrowserPane（右栏）                                            │
│   页面条 + 每页常驻 <webview src=markerUrl partition="persist:pith-browser">│
│   选中页正常 / 未选 human display:none / 未选 agent opacity:0+pe:none    │
│   dom-ready → browser:seen 握手；human 导航本地 loadURL                  │
│   工具条 / 起始页 / 查找条 / 历史 / 设备模拟 / 批注捕获层                 │
└─────────────────────────────────────────────────────────────────────────┘
```

**关键机制（沿用 pi-web 实测结论）**：
- **建页 = 控制反转**：Electron 的 CDP 不实现 `Target.createTarget` → `createPage` 入队 `pendingCreates` 并挂起（15s 超时 `BrowserHostUnavailableError`）；renderer 物化 `<webview src=markerUrl>`；reconcile 按 marker 登记 runtime；waiter 放行后**服务端**执行 `goto(url)`。
- **关页 = renderer 驱动**：webview guest 的 `page.close()` 永久挂死 → `closePage` 只摘注册表（`closingTargetIds` 2 个轮询周期宽限），renderer 卸载 `<webview>`，reconcile 消失清扫兜底。
- **同一 guest 双驱动**：agent 与人看/操作同一个 webview——agent 工作时人可直接接管；人在 guest 上的原生输入经主进程 `input-event` 中继 `bumpInteraction`，使旧 snapshot ref 失效（`StaleSnapshotError` 引导重新 snapshot）。

## 3. 文件布局

```
src/shared/browser.ts            同构纯模块（无 node 依赖，main/preload/renderer 三方共用）：
                                 marker 编解码（ELECTRON_MARKER_PREFIX → "about:blank#pith/"；
                                 buildMarkerUrl/parseMarkerUrl）、HUMAN_OWNER/agentOwner()、
                                 normalizeNavigationUrl/isAllowedNavigationUrl、
                                 BrowserPageMeta/AgentActionResult 等 DTO 形状、
                                 BROWSER_PARTITION = "persist:pith-browser"
src/main/browser/
  service.ts                     BrowserService（移植 lib/browser-service.ts；事件发射替代
                                 HTTP 拉取；consent 读 app-settings.json；无 globalThis 守卫）
  pages.ts                       纯注册表模型（lib/browser-pages.ts 原样）
  tools-core.ts                  纯工具逻辑（lib/browser-tools.ts 原样：BROWSER_TOOL_NAMES、
                                 parseSnapshotRefs/isAiRef、capSnapshotText 20k/200k、
                                 wrapUntrustedContent、diffSnapshotLines）
  tools.ts                       13 工具（browser-tools-extension.ts 改写为 pi-app
                                 customTools/ToolDefinition 形态；描述转英文）
  wiring.ts                      index.ts 调用：弹窗路由/输入中继/下载/权限 handler 安装
src/main/index.ts                CDP 双 switch（模块顶部，ready 前）+ webviewTag: true +
                                 wiring 安装 + shutdown 注册 dispose
src/main/ipc.ts                  browser:* handler 注册
src/main/pi/manager.ts           buildSession 条件注册 browser 工具（开关+consent）；
                                 disposeManaged/deleteSession → closePagesForOwner；
                                 setBrowserToolsEnabled（reload 空闲会话，流式会话等 settled）
src/main/settings.ts             AppSettings + browserConsent / browserAgentToolsEnabled
src/shared/types.ts              BrowserStatusDTO 等新 DTO
src/preload/index.ts             browser:* 方法 + onBrowserState/onBrowserPopup 订阅
src/renderer/src/
  components/app/BrowserPane.tsx        面板根：页面条 + 视图区 + 同意屏
  components/app/BrowserPageView.tsx    单页视图：webview + 工具条 + 起始页 + 查找条
  components/app/BrowserAnnotate.tsx    批注捕获层 + 高亮 overlay
  components/app/BrowserOverlays.tsx    ⋮ 菜单 / 历史面板 / 设备模拟 / 清除数据确认
  components/app/settings/BrowserSection.tsx
  lib/browser/store.ts                  面板状态 store（useSyncExternalStore）
  lib/browser/zoom.ts                   缩放阶梯 + 坐标换算 + localStorage（键 pi-app:browser-zoom）
  lib/browser/session.ts                recents(8)/open-pages(12)/history(500)（键 pi-app:browser-*）
  lib/browser/device.ts                 设备预设（原样）
  lib/browser/open-link.ts              链接打开事件 + 待处理队列（BROWSER_OPEN_LINK_EVENT）
  lib/browser/popup.ts                  browser:popup 事件 → 待处理队列（BrowserPane 挂载 drain）
  lib/markdown.tsx                      锚点拦截（明文左键 http(s) + 偏好 → 开面板建 human 页）
scripts/check-browser.mjs         纯逻辑 + service mock 级检查
scripts/check-browser-ui.mjs      真 Electron E2E（含 Electron 44 铁律重证）
```

## 4. IPC 面（HTTP 路由 → 类型化 IPC）

**方法**（`ipcMain.handle`，DTO 进 `shared/types.ts`，preload 逐一暴露）：

| 方法 | 入参 → 行为 |
|---|---|
| `browser:status` | `→ { available, consentRequired, pages: BrowserPageMeta[], pendingCreates: [{id,owner,createdAt}] }`（纯读，不踢 reconcile） |
| `browser:consent` | `→ grantConsent()`（幂等；写 app-settings.json） |
| `browser:createPage` | `{ url?: string } → createPage("human", url?)`（URL 经策略校验） |
| `browser:closePage` | `{ id } → closePage(id)` |
| `browser:seen` | `{ id, owner, url, webContentsId?, navigateTo? } → registerExternalPage`（F2 兜底 + wcId 登记 + agent popup 待导航声明） |
| `browser:elementAt` | `{ id, x, y } → ElementAtInfo \| null`（服务端 elementFromPoint 路径，UI 优先 renderer 侧 executeJavaScript） |
| `browser:theme` | `{ colorScheme: "dark"\|"light" } → setColorScheme`（CDP Emulation.setEmulatedMedia；新页注册时重放） |
| `browser:clearData` | `→ persist:pith-browser 分区 clearStorageData+clearCache+clearAuthCache` |

**事件**（`win.webContents.send`，**无 `eventSequence`**——`context_usage` 规则；高频合并冲刷 ~30ms）：
- `browser:state`：完整状态快照（同 `browser:status` 返回体）。注册表任何变更（reconcile、agent 动作、建/关页、consent、crash）后推送。renderer store 以快照整体替换，浅比较无变化不通知。
- `browser:popup`：`{ url, openerWebContentsId }`（guest 的 window.open/target=_blank 收口转发；owner 经 opener 映射继承——agent 页的弹出归 agent）。

**进程内直调（零 IPC）**：agent 工具（customTools 与 service 同进程）；input-event 中继（main 内 `bumpInteractionByWebContentsId`）。

**自动开面板**：Workspace 订阅 `browser:state`——`pendingCreates` 含 agent owner 且 browser 面板未开 → `openSidePanelTab('browser')`（事件驱动，取代 pi-web 的 2.5s 轮询兜底）。

## 5. UI 设计（beUI）

**BrowserPane**（`flex h-full min-h-0 flex-col`）：
- **页面条**：beUI `Tabs` segments（终端内层标签同款）——favicon（`page-favicon-updated`，跨站先清）/Globe 兜底 + 截断标题 + 关闭钮；`+` 新建（about:blank）；ContextMenu（关闭/关闭其他）。最后一页关闭 → `onEmpty()` 自关面板标签（SidebarPaneProps 增补回调）。
- **BrowserPageView**：`<webview src={markerUrl} partition="persist:pith-browser" {...{allowpopups:"true"}}>` 常驻；三态可见性（§2）；`dom-ready` 握手一次性闩锁（wcId 上报；**建页导航——human 与 agent 同一——交服务端 goto**（renderer 自导航会输掉与 reconcile 的 marker 竞态）；已活 human 页的地址栏导航才本地 `loadURL`，`did-navigate` 后经 `browser:seen` 刷新）；**每次 `dom-ready` 重应用缩放**（与闩锁分离——zoom-lifecycle 实测）；ResizeObserver 显式定尺寸；事件：`did-navigate`（human 页记 recents/history；marker 初始加载除外）、`did-navigate-in-page`（仅主框架）、`page-title-updated`、`page-favicon-updated`、`found-in-page`。
- **工具条**：back/forward/reload（ToolButton）· URL `Input`（回车 `normalizeNavigationUrl`）· 缩放簇 −/100%/+ · 批注开关 · `⋮` MorphPopover。下载指示：工具条 transient Download 图标钮 → 点击 `shell.showItemInFolder`。
- **同意屏**：`consentRequired` → 居中卡片 + beUI Button 授予（双语文案：共享持久登录态告知）。
- **起始页**：about:blank 覆盖层 = URL 输入 + 最近打开列表（beUI Button 行，`useSyncExternalStore` 订阅）；每次打开面板自动开一个 about:blank（一次性闩锁，等首个 status）；空态起始页仅短暂兜底。
- **查找条**：右上浮层 `Input` + `x/y`（固定宽 tabular-nums）+ 上/下/关；去抖 200ms 新搜索；`finalUpdate` 后取 ordinal/matches 终值；Enter/Shift+Enter 上下；Esc 输入框让位规则。
- **历史面板**：MorphPopover 列表（≤500 条、点击当前页打开、清空按钮、favicon 回落站点根）。
- **设备模拟**：Select 预设（iPhone SE/15 Pro/Pixel 8/Galaxy S23/iPad Air）+ 自定义宽高 Input（草稿值，失焦夹取 200–3840）；webview 元素钉预设尺寸居中呈机身框（**元素级视口，禁 CDP setDeviceMetrics**——保住「guest 视口 == 元素」不变量）；批注坐标全以 webview 元素 rect 为原点（`guestOffset()`）。
- **缩放**：Chromium 阶梯 25%–300%（平局吸附低档）× uiScale(=1)；全局档 localStorage；`webview.setZoomFactor` 绝对值写入；快捷键 ⌘±/⌘0 仅选中页。
- **批注模式**（BrowserAnnotate）：捕获层 div 全程常驻拦截 guest 全部指针事件；选中态点击框内=取消/框外=改选；hover 预览 80ms 节流 + 序号守卫（`executeJavaScript` elementFromPoint，与服务端同源脚本）；点击与最近 hover <3px 直接复用；**滚轮显式转发**：`sendInputEvent({type:"mouseWheel", x, y, deltaX, deltaY})` 纯像素 delta、**符号取反**、**主轴判定清零副轴**（|dy|≥|dx| → dx=0，macOS 触控板副轴噪声）；滚动期间抑制高亮、250ms 落定后解析一次；Esc 退出（仅面板激活标签，window 捕获 + stopPropagation，文本输入让位）；提交 → renderer CustomEvent（`pith:browser-annotation`）→ Workspace → Composer 草稿插入。
- **快捷键**：⌘F/⌘±0/⌘P 仅当 browser 为活动 rail 标签且作用于选中页（window 捕获 + stopPropagation）。
- 全部字符串走 `t()`（en + zh-CN 同步，Messages 类型强制）；`aria-label`/`title` 不例外；滚动条全局隐藏；`rounded-control/card` 语义圆角；浮层 `shadow-overlay`。

**聊天外链**（markdown.tsx 锚点渲染器）：偏好 `pi-app:open-links-in-browser`（默认开，Settings 可关，仅桌面形态显示该行）开时，明文左键 http(s) → `open-link.ts` 入队 + 事件 → Workspace 开面板 → BrowserPane 建 human 页并导航；修饰键点击 / 非白名单 scheme → 现有外部行为不变。

## 6. Agent 工具（13 个，`BROWSER_TOOL_NAMES`）

`browser_navigate / browser_pages / browser_focus / browser_snapshot / browser_click / browser_hover / browser_select / browser_type / browser_press_key / browser_scroll / browser_wait_for / browser_screenshot / browser_close`

- **注册**：buildSession `customTools` 条件注册（`browserAgentToolsEnabled`）；owner = `agent:<canonical session id>`（SDK sessionManager 的稳定 id，fork 不变）。描述与 `promptSnippet` 英文（pi-app 惯例）；`UNTRUSTED_NOTE` 与 `<<<untrusted-web-content>>>` 边界原样（模型侧指令注入防线）。
- **执行语义**（全部沿用 service 层实现，含超时纪律）：动作/导航超时 8s/20s（绝不容 playwright 默认 30s 挂死）；type = click → `ControlOrMeta+A` → `pressSequentially`（`fill()` 禁用）；scroll = CDP mouseWheel（视口中心）+ scrollY 校验 + `scrollBy` 兜底；reload = `goto(url)`（`Page.reload` 会杀死 guest）；settle（120ms 预热 → MutationObserver 120ms×2 静默 → 1.5s 预算截断）后才 snapshot；snapshot = `ariaSnapshot({mode:"ai"})`，ref allow-list 全量重建，`selector` 子树 / `diff` 行级差异 / `maxChars` 20k 默认 200k 硬顶；screenshot = JPEG q60（5s 失败重试 8s 一次），`annotate` 离屏 canvas 合成 ref 标签（≤50 个，失败静默回退原图）；wait_for 超时不报错、未满足条件列在不可信边界外。
- **错误映射**：`ConsentRequiredError` → 文本引导模型请用户开浏览器面板确认（模型不得代确认）；`BrowserHostUnavailableError` → 引导重试一次/通知用户开面板；Stale/InvalidRef/PageGone/PageNotFound/NavigationBlocked 各有明确文本。
- **四处同步清单**：`initializeSession` 激活集（开关开时）· `APP_TOOL_NAMES`（catalog builtin 分类）· `TOOL_ICONS`（每工具一枚 Lucide 映射）· `TOOL_CATEGORIES` 新增 `browser` 类别。子代理 profile 可按名授权（customTools `source=sdk`，ceiling 按名放行——不额外做事）。
- **开关即时生效**：Settings 变更 → main 更新 app-settings.json → `setBrowserToolsEnabled` 走 `setAppendPrompt` 模式：空闲会话立即 `reload()`，流式会话等 `agent_settled` 后补。
- **会话生命周期**：`disposeManaged` 与 `deleteSession` → `closePagesForOwner(agent:<id>)`（agent 页随会话回收）；运行中止**不**关页（跨 turn 保留，与 pi-web 一致）。
- **截图渲染**：`browser_screenshot` 返回 image content——走现有工具结果图片路径（实现时核对 ToolCallView 图片渲染，缺则补；预览走 ImagePreviewProvider）。

## 7. 设置

- `src/main/settings.ts` `AppSettings` 增：`browserConsent: boolean`（默认 false）、`browserAgentToolsEnabled: boolean`（默认 **false**）。经 `app:info`（AppInfoDTO）暴露 + `app:setBrowserAgentTools` / `browser:consent` 写入。
- **Settings → Browser** 区（SECTIONS 一条，首次激活懒挂载）：
  - Agent 浏览器工具开关（**方形 Checkbox**，`mark="square"`——本分支开关规矩；说明文字含「需先在浏览器面板完成一次性确认」）；
  - 链接在内置浏览器打开（方形 Checkbox）；
  - 清除浏览数据（两步确认，含登录态告知 → `browser:clearData`）。

## 8. 持久化

| 数据 | 位置 | 形状/限额 |
|---|---|---|
| 页面缩放档 | localStorage `pi-app:browser-zoom` | 阶梯值 |
| 最近打开 | localStorage `pi-app:browser-recents` | `string[]` ≤8，仅 human 真实导航（SPA in-page 不记） |
| 打开页快照 | localStorage `pi-app:browser-open-pages` | `string[]` ≤12，持续派生落盘（同值跳过）；重开面板时无页且 consent 已过则逐页恢复；实时来客（pages 非空）优先于恢复 |
| 浏览历史 | localStorage `pi-app:browser-history` | `{url,title,favicon?,at}[]` ≤500，连续同 URL 去重、title/favicon 回填 |
| 链接偏好 | localStorage `pi-app:open-links-in-browser` | 默认开 |
| consent / 工具开关 | `<userData>/app-settings.json` | main 侧权威 |
| 浏览 profile | `<userData>/Partitions/pith-browser` | cookies/登录态持久；clearData 清空 |
| 建页 URL 预写 | （内存）localNav | 建页即预写目标 URL——页面条/快照在 did-navigate 前就有真实 URL，慢加载页关面板不丢快照 |

## 9. 安全模型

1. **调试端口**：仅 127.0.0.1、每次启动随机（19000–38999）、`remote-allow-origins=http://127.0.0.1`（playwright CDP WS 的 Origin 头否则被拒）。常开的理由：`appendSwitch` 只在 ready 前有效，开关式启用会要求重启应用，且建页握手依赖确定性连接。接受残余风险：本机任意进程理论上可连此端口驱动 app（本地攻击者本已等价于用户）。
2. **导航白名单**：主 frame 仅 `http:`/`https:`/`about:blank`（可带 marker fragment）——URL 栏、`browser_navigate`、服务端 goto 全部收口于 `shared/browser.ts` 的 `isAllowedNavigationUrl`；弹窗不做 scheme 门控（Chrome 自身阻止 file:/chrome:/javascript:，与 pi-web 同决策）。
3. **弹窗路由**：per-contents `setWindowOpenHandler`——marker URL 一律 deny（伪造只记一次日志）；壳窗口 http(s) deny + `shell.openExternal`（沿用 pi-app 现行为）；webview guest deny + `browser:popup` 事件（owner 经 opener 继承）。
4. **权限**：browser 分区 `setPermissionRequestHandler`——默认拒绝全部敏感权限（geolocation/notifications/media（麦克风与摄像头）/midi/serial/usb/bluetooth），仅放行 `fullscreen`、`clipboard-sanitized-write`、`pointerLock`（pi-web 未做，本移植补上）。
5. **不可信内容边界**：工具返回的页面来源文本全部 `wrapUntrustedContent` 包裹 + 工具描述含注入警示；**页面自报的 url/title 即使出现在 app 拼装的列表里也在边界内**（`browser_pages` 的行列表、`New pages` 的行列表各自整体包裹——页面可以把标题写成指令）；只有 id/计数/标签等 app 自产字段（`activePageId:` 行、段头、收尾指引、unmet 条件）在边界外。
6. **绝不上溯 shell 能力**：guest 无 node、preload 不注入 webview；`webviewTag: true` 仅为承载，guest 与 app 同 contextIsolation 边界。

## 10. 生命周期与退出

- service 单例懒建（首次 `browser:*` 调用或工具执行）；CDP 连接 single-flight；reconcile timer `unref`。
- **断线**（`disconnected`）：runtime 全清、注册表清空、下次 `ensureStarted` 重连——视为壳重启自愈路径。
- **退出**：`shutdown.ts` cleanup 列表追加 service dispose——**只丢引用，绝不 `browser.close()`**（connectOverCDP 的 Browser.close 发 CDP `Browser.close` 会退出整个 app）；CDP WS 随进程退出关闭。
- **会话删除/dispose**：关该 owner 全部页（renderer 卸载 guest 由 reconcile 兜底）。

## 11. 实测铁律（Electron webview × playwright，移植不得违反）

来自 pi-web `electron-webview-spike.mjs` 的 13 条实测，`check-browser-ui.mjs` 在 Electron 44 上重证：

1. Electron CDP 不实现 `Target.createTarget` → 建页走 pendingCreate 握手；
2. guest `page.close()` 永久挂死 → 关页 renderer 驱动；
3. `display:none` guest：click 超时 / screenshot 永不返回 / `fill` 静默无效 → 后台 agent 页 `opacity:0 + pointer-events:none` 满尺寸（timer/rAF 满速）；未选 human 页可 `display:none`；
4. `fill()`（`Input.insertText`）在非可见 guest 静默无效 → type 走键盘事件链；
5. 合成 CDP wheel 在 guest 非确定性被吞 → scrollBy 兜底；
6. `Page.reload` 杀死 guest（或打到壳窗口=假重启）→ reload 重实现为 `goto(currentUrl)`；
7. CDP 连接前已存在的 guest 不进 `context.pages()`（Electron 43 实测）→ `browser:seen` state-only 登记 + reconcile 升级；
8. 垂死/隐藏 guest 的 captureScreenshot 永不返回 → 显式 5s 超时 + 8s 重试一次；
9. `DOM.getNodeForLocation` 跨进程导航后不可靠 → elementFromPoint 页内求值；
10. `window.open` 子窗口不继承 preload；
11. playwright connectOverCDP 给既有 target 钉死 `prefers-color-scheme: light`（含壳窗口！）→ 逐 Page `emulateMedia(null)` 清除（必须走 playwright API，裸 CDP 会话压不过）；app 主题经 `Emulation.setEmulatedMedia` 注入 + 注册时重放；
12. `browser.close()`/`context.close()` = CDP `Browser.close` = **退出整个应用**——永不调用；
13. marker target 的 page 事件与 reconcile 竞态 → 弹窗登记让一个宏任务 + Page 身份去重；`closingTargetIds` 2s 宽限防重登。

另：webview 的 `allowpopups` 必须字符串展开（React 剥布尔属性）；批注滚轮转发纯像素 delta + 符号取反 + 副轴清零（wheelTicks/preciseDeltas 载荷被 guest 静默吞掉）；zoom 每次 `dom-ready` 重应用（不能与一次性握手共用闩锁）。

## 12. 相对参考实现的改进（“提升”）

1. **事件驱动状态同步**：`browser:state` 推送取代 2.5s 轮询——建页握手延迟从最坏 2.5s 降到事件往返；reconcile 内部 1s 轮询保留（marker 时序不可靠，事件只是 best-effort）。
2. **权限处理器**：pi-web 完全没有 `setPermissionRequestHandler`（默认放行）；本移植默认拒绝敏感权限。
3. **零 HTTP 中继**：input-event → bumpInteraction 进程内直调（pi-web 走 HTTP POST）。
4. **beUI 原生 UI + 完整双语**（pi-web 为自绘 CSS + 单语）；无滚动条 chrome、圆角/阴影策略一致。
5. **工具目录/图标/类别/子代理 ceiling 集成**（pi-app 生态原生）。
6. **Electron 44 铁律重证**：check-browser-ui 把 13 条实测固化为回归断言，防大版本漂移。
7. **下载指示**入工具条（pi-web 为完成对话框打断）；清除数据两步确认保持。

## 13. 测试计划

1. **`scripts/check-browser.mjs`**（无 Electron）：
   - 纯逻辑断言：policy（裸域/host:port 归一、白名单）、marker 编解码、pages 注册表（含 active 切换清 snapshot、interactionGeneration）、tools-core（ref 解析、截断、LCS diff、不可信包裹）、zoom（阶梯/吸附/坐标换算）、session（recents/history/快照纯函数）、device（预设/夹取）；
   - service 级：playwright 结构 mock（PageLike/CdpSessionLike 注入）+ `autoMaterialize`（5ms 轮询把 pendingCreates 物化为 marker mock page 并踢 reconcile——模拟 renderer）；覆盖：建页握手（含超时）、关页宽限、弹窗归属继承、断线自愈、ref 失效（bumpInteraction）、settle 计时注入归零、错误类映射。
2. **`scripts/check-browser-ui.mjs`**（check-terminal.mjs 模板：先 `npm run build`，隔离 profile，`PITH_CDP_PORT` 固定，Vite fixture 挂真实 BrowserPane + window.pi 桩，CDP WebSocket 驱动断言 + 截图）：
   - §11 的 13 条铁律重证（Target.createTarget 缺失、close 挂死、display:none 三症状、fill 无效、reload 杀 guest、预连接 guest 不可见、截图超时、emulateMedia 钉死、browser.close 危险——以“存在性断言+代码路径”或最小化实测）；
   - 真实链路：marker 握手 → reconcile 登记 → human 导航（URL 条/前进后退/历史/recents）→ agent 工具全流程（navigate→snapshot→click→type→scroll→screenshot→close）→ 人输入使 ref 失效 → 弹窗路由（window.open → browser:popup → owner 继承）→ 缩放生命周期（每次 dom-ready 重应用）→ 查找 → 设备模拟 → 批注（hover/点选/滚轮转发符号与副轴/Esc）→ consent 屏 → clearData → 下载自动保存 → 双语 + 主题（亮暗 setEmulatedMedia）。
3. **既有回归**：`check-icons`（新图标映射）、`check-tool-catalog`、`check-settings-tabs`（新区段懒挂载）、`npm run typecheck && npm run build`。

## 14. 实施分期（供 writing-plans 展开）

- **P1 基础**：依赖（playwright-core）、CDP 开关 + webviewTag、`shared/browser.ts`（含 policy 与 marker）、`main/browser/{service,pages,tools-core,wiring}`、IPC + preload、settings/consent、生命周期接线（shutdown/session dispose）。
- **P2 面板**：BrowserPane 骨架（页面条/webview 三态/握手/起始页/同意屏/URL 工具条/back-fwd-reload）+ store + 事件。
- **P3 工具**：tools.ts 注册、四处同步、开关即时生效、自动开面板、Settings → Browser 区。
- **P4 完善**：缩放/查找/打印/历史/recents/恢复/设备模拟/清除数据/下载指示/链接拦截/markdown 锚点。
- **P5 批注**：捕获层/overlay/滚轮转发/插入 Composer。
- **P6 收尾**：check-browser.mjs + check-browser-ui.mjs 全量、AGENTS.md 域条目、docs/architecture/embedded-browser.md 改写、README 一句。
