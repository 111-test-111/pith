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

/**
 * 截断超长 snapshot。截断只影响返回给模型的文本——服务侧记录的 ref 全集不受影响，
 * 被截掉区域的 ref 仍可交互（模型可用 browser_snapshot 的 selector 缩小范围再看）。
 */
export function capSnapshotText(text: string, maxChars: number = SNAPSHOT_DEFAULT_MAX_CHARS): string {
  const cap = Math.min(Math.max(0, Math.floor(maxChars)), SNAPSHOT_MAX_CHARS_LIMIT)
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n\n[快照已截断：共 ${text.length} 字符，仅显示前 ${cap}。需要其余部分时，用 browser_snapshot 的 selector 参数圈定子区域。]`
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
 * 未变化的长段折叠成计数行；两侧完全相同返回 '(快照无变化)'。
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
    if (unchanged > 0) out.push(`  … ${unchanged} 行未变化 …`)
    unchanged = 0
  }
  for (const op of ops) {
    if (op.type === 'same') { unchanged++; continue }
    flushUnchanged()
    out.push(`${op.type === 'del' ? '-' : '+'} ${op.line}`)
  }
  flushUnchanged()
  if (out.every((line) => line.startsWith('  …'))) return '(快照无变化)'
  return out.join('\n')
}
