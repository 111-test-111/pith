/**
 * agent 浏览器工具的纯逻辑：工具名集合、AI snapshot ref 解析、
 * snapshot 体量控制、不可信内容边界、行级 diff。
 * 纯模块（不 import Electron/playwright）——主进程的工具注册层共用。
 */
export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_pages',
  'browser_focus',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_scroll',
  'browser_wait_for',
  'browser_screenshot',
  'browser_close',
  'browser_hover',
  'browser_select',
  'browser_upload',
] as const

// Playwright AI snapshot 的 ref：主 frame 为 eN，iframe 内为 f<frameSeq>eN（如 f1e46）。
const REF_RE = /\[ref=((?:f\d+)?e\d+)\]/g

/** 从 AI aria snapshot YAML 中提取全部 ref。 */
export function parseSnapshotRefs(snapshot: string): Set<string> {
  const refs = new Set<string>()
  for (const match of snapshot.matchAll(REF_RE)) refs.add(match[1])
  return refs
}

/** Playwright AI ref 形态校验（避免把任意字符串拼进 aria-ref selector）。 */
export function isAiRef(value: unknown): value is string {
  return typeof value === 'string' && /^(?:f\d+)?e\d+$/.test(value)
}

// ---- snapshot 返回体量控制 + 不可信内容边界 ----

/** 动作返回 snapshot 的默认字符上限：大页面整页快照可达数万 token，必须截断。 */
export const SNAPSHOT_DEFAULT_MAX_CHARS = 20_000
/** 调用方显式放大上限时的硬顶（防误传巨大值打爆上下文）。 */
export const SNAPSHOT_MAX_CHARS_LIMIT = 200_000

/** 上限归一：缺省/非有限值 → 默认；负数 → 0；超硬顶 → 硬顶。 */
export function clampSnapshotMaxChars(maxChars?: number): number {
  if (maxChars === undefined || !Number.isFinite(maxChars)) return SNAPSHOT_DEFAULT_MAX_CHARS
  return Math.min(Math.max(0, Math.floor(maxChars)), SNAPSHOT_MAX_CHARS_LIMIT)
}

export interface IngestedSnapshot {
  /** 交付模型的内容（窗口内文本，不含截断说明行）。 */
  visible: string
  /** 窗口之后还有内容。 */
  truncated: boolean
  totalChars: number
  cap: number
  /** 本次窗口在原文里的起始字符偏移（分页读长页面用）。 */
  offset: number
}

/** 偏移归一：缺省/非有限值 → 0；负数 → 0；小数 → 向下取整。 */
export function normalizeSnapshotOffset(offset?: number): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0
  return Math.max(0, Math.floor(offset))
}

/**
 * 把页面文本裁剪成「模型实际看到的那一段」。
 *
 * 单一入口的原因：截断、说明行与 `browser_snapshot diff` 的基线必须同源。基线一旦用
 * 未裁剪的全文，模型从未见过的内容就会被当作「上次你看到的状态」，于是一个开在下半页
 * 的模态框会被 diff 报成 `(no snapshot change)`——对工具自身正确，对模型是谎话。
 *
 * `offset` 是**分页**而不是另一种截断：快照是文档序前缀（滚动不改变它），长页面只能靠
 * `[offset, offset+cap)` 这个窗口一段段读完——不需要猜 CSS。
 * 截断只影响返回文本与服务侧基线——注册表里的 ref 全集不受影响，被截掉区域的 ref
 * 仍可交互。
 */
export function ingestSnapshot(text: string, maxChars?: number, offset?: number): IngestedSnapshot {
  const cap = clampSnapshotMaxChars(maxChars)
  const requested = Math.min(normalizeSnapshotOffset(offset), text.length)
  const start = snapToLineStart(text, requested, cap)
  const visible = text.slice(start, start + cap)
  return {
    visible,
    truncated: start + visible.length < text.length,
    totalChars: text.length,
    cap,
    offset: start,
  }
}

/**
 * 把窗口起点吸附到行首。字符 offset 会切在行中间（实测：3000-7500 那窗的第一行是半截
 * `[ref=f1e92] [cursor=pointer]:`），半截行既难读也容易让模型误判结构。
 *
 * 吸附只往回走**一小段**，而且必须保证窗口仍能向前推进：整页只有一行（超长单行）时
 * 行首永远是 0，无条件吸附会让 next 停在原地、模型永远在同一段上打转。所以只在「吸附后
 * 窗口末尾仍在请求位置之后」时才吸附。
 */
function snapToLineStart(text: string, requested: number, cap: number): number {
  if (requested <= 0) return 0
  const nl = text.lastIndexOf('\n', requested - 1)
  if (nl < 0) return requested
  const lineStart = nl + 1
  return lineStart < requested && lineStart + cap > requested ? lineStart : requested
}

/**
 * 截断说明（app 自产数据 → 工具层放在不可信边界之外）。
 * 文本英文：工具输出是模型上下文（与工具描述/错误文本同语），不跟界面语言走。
 * 必须同时点出 selector 与 maxChars 两个逃生口：只提 selector 时模型会在真实站点上
 * 盲猜 CSS（实测 GitHub 设置页：两次猜错、一次多匹配失败）。
 */
export function snapshotTruncationNote(s: IngestedSnapshot): string {
  const next = s.offset + s.visible.length
  const more = next < s.totalChars
    ? ` Call browser_snapshot again with offset=${next} to read on from there.`
    : ''
  return `[Snapshot truncated: ${s.totalChars} characters total, showing characters ${s.offset}-${next}.${more} selector can narrow it to a subtree instead, and maxChars (the page-action tools accept it too) raises the limit for a single call.]`
}

/**
 * 截断时的补充说明：diff 只比较可见前缀，所以「没变」只覆盖窗口内的内容。
 * 没有这句，模型会把窗口外的静默改动读成「页面没变」。
 */
export function snapshotBeyondCapNote(s: IngestedSnapshot): string {
  const next = s.offset + s.visible.length
  return `[Note: this page is ${s.totalChars} characters and only characters ${s.offset}-${next} are compared above. A change past that point would not appear here — re-read with offset=${next} or a larger maxChars to inspect the rest.]`
}

/** offset 超过结尾（拿着一个过期偏移再来一次）：必须说出来，不能只给个空块。 */
export function snapshotOffsetPastEndNote(offset: number, totalChars: number): string {
  return `[offset=${offset} is past the end of this ${totalChars}-character snapshot, so nothing is shown. Re-read with offset=0, or with a smaller offset.]`
}

/**
 * 动作后未观察到 DOM mutation。
 * 刻意只说「没采到变化」而不说「什么也没发生」：勾选框变选、焦点移动、CSS hover /
 * canvas 重绘都不产生 mutation，但它们确实发生了——把话说满会让模型误判动作无效。
 */
export function noDomChangeNote(): string {
  return '[Nothing observable changed: no DOM mutation was observed while settling, and the accessibility snapshot you just received is identical to the previous one. A purely visual change (a CSS hover/active style, a canvas or video redraw) can still have happened — take a screenshot before concluding.]'
}

/**
 * 键盘重放（pressSequentially）的单次文本上限。
 * 铁律 4 禁用 `fill()`（在非可见 guest 上静默无效），所以长文本只能一个一个键打出去，
 * 而每次动作只有 8s 预算——超长输入会以 Playwright 超时报错，而不是一句能懂的话。
 */
export const TYPE_TEXT_MAX_CHARS = 8_000

/** 工具层预检与 service 拦下时共用同一句话（不许两处漂移）。 */
export function typeTextTooLongText(length: number): string {
  return `textTooLong: text is ${length} characters, over the ${TYPE_TEXT_MAX_CHARS}-character limit for keystroke replay (every character becomes a real key event and an action has an 8s budget, so a longer value would die as a timeout instead of arriving). Send a shorter value, or set the long content by another route.`
}

/**
 * browser_upload 单次可带的文件数上限。一次上传是给页面的一个动作（不是批量导入
 * 接口），上限的作用是让「误传一整个目录」变成一句可读的错，而不是一次巨型 setInputFiles。
 */
export const UPLOAD_MAX_FILES = 20

/** 上传路径预检失败的一条：路径 + 原因（两者都是 app 自产文本）。 */
export interface UploadPathProblem {
  path: string
  reason: string
}

/** 路径预检失败的交付文本（英文——工具输出是模型上下文，不跟界面语言走）。 */
export function uploadPathsErrorText(problems: UploadPathProblem[]): string {
  const lines = problems.map((problem) => `- ${problem.path}: ${problem.reason}`).join('\n')
  return `error: cannot upload these local paths:\n${lines}`
}

/** 文件数超限的交付文本。 */
export function uploadTooManyText(count: number): string {
  return `error: ${count} files given, over the ${UPLOAD_MAX_FILES}-file limit of one upload call. Split it into several browser_upload calls (the file input usually keeps what it already has).`
}

/**
 * 上传结果说明（app 自产 → 交付文本的边界之外）。页面常用图标/"1 file selected"
 * 这种不含文件名的措辞，模型无法从快照确认挂上去的到底是不是自己给的那几个。
 */
export function uploadNote(files: string[]): string {
  const names = files.map(uploadFileName)
  return `[Attached ${names.length} file${names.length === 1 ? '' : 's'}: ${names.join(', ')}.]`
}

/** 路径末段：posix 与 windows 分隔符都吃，说明文本里只报文件名。 */
function uploadFileName(file: string): string {
  const parts = file.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? file
}

/** 兼容入口：只要交付文本（已裁剪，不含说明行——说明由工具层加在边界外）。 */
export function capSnapshotText(text: string, maxChars?: number): string {
  return ingestSnapshot(text, maxChars).visible
}

// ---- app 自产说明（工具层追加在不可信边界之外）----

/** 空 a11y 树的诊断快照（由页内 measure 得到，全是数字/枚举，不是页面自写文本）。 */
export interface EmptySnapshotDiagnostics {
  readyState: string
  childElements: number
  textChars: number
}

/**
 * 空快照说明。aria 树为空可能意味着两件完全不同的事：「这个文档确实没有可访问内容」
 * 与「把页面建出来的脚本挂了」——旧实现只给一个空块，模型无从分辨（实测：一个 body
 * 里只有 fetch() 的页返回空块 + 全黑截图，只能猜）。这里把可测的事实摆出来。
 */
export function emptySnapshotNote(diag: EmptySnapshotDiagnostics): string {
  return `[The accessibility tree is empty. Measured: readyState=${diag.readyState || 'unknown'}, <body> child elements=${diag.childElements}, visible text length=${diag.textChars}. An empty tree can mean the document genuinely has no accessible content, or that a script that builds the page did not finish or failed — see any page problems reported below, and consider browser_screenshot.]`
}

/** 页面自报的一条问题（pageerror / console.error）。 */
export interface PageIssueLike {
  kind: 'error' | 'console'
  text: string
}

/**
 * 页面自报问题说明。
 *
 * **文本是页面自写的**（异常消息、console.error 的实参），所以行列表必须留在不可信
 * 边界之内——把它当 app 自产文本放在边界外，就等于让页面自己往边界外注入指令。
 * 框外只有 app 自产的引导句。
 */
export function pageIssuesNote(issues: PageIssueLike[], shown = 3): string {
  const list = issues.slice(0, shown)
  const lines = list.map((issue) => `- ${issue.kind === 'error' ? 'uncaught error' : 'console.error'}: ${issue.text}`)
  const more = issues.length - list.length
  if (more > 0) lines.push(`- (and ${more} more, not shown)`)
  return `[The page reported ${issues.length} problem(s) since the last snapshot (page-authored text, untrusted):\n${wrapUntrustedContent(lines.join('\n'))}]`
}

/** 滚动位置（页内 measure 得到）。 */
export interface ScrollPosition {
  x: number
  y: number
  viewportWidth: number
  viewportHeight: number
  scrollWidth: number
  scrollHeight: number
}

/**
 * 滚动结果说明。滚动是唯一在快照里看不出效果的动作（快照是**文档序**前缀，不随视口
 * 移动）：不给位置/总量，模型无法判断到底有没有滚动、还能不能继续滚（实测：一次
 * deltaY=6000 的滚动返回的文本与滚动前逐字相同）。
 */
export function scrollPositionNote(p: ScrollPosition): string {
  const maxY = Math.max(0, p.scrollHeight - p.viewportHeight)
  const maxX = Math.max(0, p.scrollWidth - p.viewportWidth)
  const below = Math.max(0, maxY - p.y)
  return `[Scroll position: y=${p.y}/${maxY} (viewport ${p.viewportHeight}px; ${below}px further down), x=${p.x}/${maxX}. Document ${p.scrollWidth}×${p.scrollHeight} CSS px.]`
}

/**
 * 焦点变化说明（只报变化）——没这条时浏览器按键（Tab/Escape）在快照无差异时完全
 * 不可验证。只报元素**标签名**：标签名来自固定词汇表，而 aria-label/placeholder/
 * innerText 都是页面自写文本，要报就得再开一层不可信边界，不值当。
 */
export function focusChangedNote(tag: string): string {
  return `[Focus moved to <${tag}>.]`
}

export const UNTRUSTED_CONTENT_BEGIN = '<<<untrusted-web-content>>>'
export const UNTRUSTED_CONTENT_END = '<<<end-untrusted-web-content>>>'

/**
 * 把页面来源的文本包进边界标记：网页内容是不可信数据，
 * 显式边界帮助模型区分「数据」与「指令」（与工具描述里的 UNTRUSTED_NOTE 呼应）。
 */
export function wrapUntrustedContent(text: string): string {
  return `${UNTRUSTED_CONTENT_BEGIN}\n${text}\n${UNTRUSTED_CONTENT_END}`
}

/**
 * 行级 LCS diff：snapshot 行数有限（数百行级），O(n·m) 矩阵可接受；
 * 超大输入直接返回新快照全文（调用方仍会截断兜底）。
 * 未变化的长段折叠成计数行；两侧完全相同返回 '(no snapshot change)'。
 */
export function diffSnapshotLines(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  if (oldLines.length * newLines.length > 4_000_000) return newText
  const n = oldLines.length
  const m = newLines.length
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const ops: Array<{ type: 'same' | 'del' | 'add'; line: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { ops.push({ type: 'same', line: oldLines[i] }); i++; j++ }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { ops.push({ type: 'del', line: oldLines[i] }); i++ }
    else { ops.push({ type: 'add', line: newLines[j] }); j++ }
  }
  while (i < n) ops.push({ type: 'del', line: oldLines[i++] })
  while (j < m) ops.push({ type: 'add', line: newLines[j++] })
  const out: string[] = []
  let unchanged = 0
  const flushUnchanged = () => {
    if (unchanged > 0) out.push(`  … ${unchanged} unchanged line(s) …`)
    unchanged = 0
  }
  for (const op of ops) {
    if (op.type === 'same') { unchanged++; continue }
    flushUnchanged()
    out.push(`${op.type === 'del' ? '-' : '+'} ${op.line}`)
  }
  flushUnchanged()
  if (out.every((line) => line.startsWith('  …'))) return '(no snapshot change)'
  return out.join('\n')
}
