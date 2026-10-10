import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AssistantMsg } from '../../../shared/types'
import { ASK_USER_TOOL_NAME } from '../../../shared/ask-user'
import type { Locale } from '@/i18n'
import { toolCategory } from './tool-categories'

/**
 * Claude Code style "spinner verbs" — the playful status sentences the waiting
 * row plays while a turn runs. Ported from pi-web's `lib/cc-spinner-verbs.ts`;
 * the rules that make it read well are the same two:
 *
 * 1. Targeted randomness — the sentence is picked from the pool matching the
 *    turn's frontier step (reasoning, or the kind of tool call that is
 *    running), so it stays loosely relevant instead of being pure noise.
 * 2. Constant cadence — the sentence NEVER follows step changes. It rotates on
 *    wall-clock slots (`spinnerSlotAt`), so every live row switches at the same
 *    moments and a remount cannot reset the rhythm. Within a slot the step
 *    context is latched: switching tools mid-slot does not swap the sentence.
 *
 * The pick is a pure hash of (seedKey, slot): deterministic across re-renders
 * and remounts, yet uncorrelated between slots and sessions.
 *
 * All locales live in this table (per the owner's decision) instead of in
 * `i18n/locales/*`: 53 sentences × 3 locales would swamp the dictionaries, and
 * the list is data with a stable per-entry id rather than UI prose. The header
 * sentence below is the only string read from this module.
 */
export interface SpinnerVerb {
  /**
   * Stable gerund key ("Tinkering") — pool membership and animation identity
   * reference this; the displayed sentences may be reworded freely without
   * touching either.
   */
  id: string
  /** Sentence shown for `en` ("Pi is tinkering with the tricky bits"). */
  en: string
  /** Localized sentence shown for zh-CN. */
  zh: string
  /** Localized sentence shown for zh-TW. */
  tw: string
}

/** Rotation cadence: one sentence per wall-clock slot. */
export const SPINNER_VERB_INTERVAL_MS = 10_000

/**
 * The word list (53 entries). Each keeps the classic Claude Code gerund as its
 * stable `id`, while `en`/`zh` are short first-person-Pi status sentences —
 * vivid beats terse.
 */
export const SPINNER_VERBS: readonly SpinnerVerb[] = [
  { id: 'Accomplishing', en: 'Pi is getting it done', zh: 'Pi 正在搞定任务', tw: 'Pi 正在搞定任務' },
  { id: 'Actualizing', en: 'Pi is making it real', zh: 'Pi 正在把构想变成现实', tw: 'Pi 正在把構想變成現實' },
  { id: 'Architecting', en: 'Pi is architecting the structure', zh: 'Pi 正在搭建骨架', tw: 'Pi 正在搭建骨架' },
  { id: 'Calculating', en: 'Pi is crunching the numbers', zh: 'Pi 正在飞速计算', tw: 'Pi 正在飛速計算' },
  { id: 'Cascading', en: 'Pi is riding the network waves', zh: 'Pi 正在网上冲浪', tw: 'Pi 正在網路衝浪' },
  { id: 'Channeling', en: 'Pi is channeling the web', zh: 'Pi 正在接通网络', tw: 'Pi 正在接通網路' },
  { id: 'Choreographing', en: 'Pi is choreographing the steps', zh: 'Pi 正在编排舞步', tw: 'Pi 正在編排舞步' },
  { id: 'Coalescing', en: 'Pi is gathering the scattered pieces', zh: 'Pi 正在汇聚碎片', tw: 'Pi 正在匯聚碎片' },
  { id: 'Composing', en: 'Pi is composing fresh code', zh: 'Pi 正在谱写代码', tw: 'Pi 正在譜寫程式碼' },
  { id: 'Computing', en: 'Pi is firing up the silicon', zh: 'Pi 正在全速运算', tw: 'Pi 正在全速運算' },
  { id: 'Considering', en: 'Pi is weighing the options', zh: 'Pi 正在权衡方案', tw: 'Pi 正在權衡方案' },
  { id: 'Contemplating', en: 'Pi is contemplating the approach', zh: 'Pi 正在沉思对策', tw: 'Pi 正在沉思對策' },
  { id: 'Crafting', en: 'Pi is crafting with care', zh: 'Pi 正在精雕细琢', tw: 'Pi 正在精雕細琢' },
  { id: 'Creating', en: 'Pi is conjuring new files', zh: 'Pi 正在变出新文件', tw: 'Pi 正在變出新檔案' },
  { id: 'Crystallizing', en: 'Pi is crystallizing the details', zh: 'Pi 正在让细节成形', tw: 'Pi 正在讓細節成形' },
  { id: 'Cultivating', en: 'Pi is growing the codebase', zh: 'Pi 正在培育代码', tw: 'Pi 正在培育程式碼' },
  { id: 'Deciphering', en: 'Pi is deciphering the code', zh: 'Pi 正在破译代码', tw: 'Pi 正在破譯程式碼' },
  { id: 'Deliberating', en: 'Pi is deliberating the trade-offs', zh: 'Pi 正在斟酌取舍', tw: 'Pi 正在斟酌取捨' },
  { id: 'Determining', en: 'Pi is zeroing in on the answer', zh: 'Pi 正在锁定答案', tw: 'Pi 正在鎖定答案' },
  { id: 'Effecting', en: 'Pi is making it happen', zh: 'Pi 正在让一切发生', tw: 'Pi 正在讓一切發生' },
  { id: 'Elucidating', en: 'Pi is shining a light on it', zh: 'Pi 正在拨开迷雾', tw: 'Pi 正在撥開迷霧' },
  { id: 'Envisioning', en: 'Pi is envisioning the big picture', zh: 'Pi 正在构想蓝图', tw: 'Pi 正在構想藍圖' },
  { id: 'Flowing', en: 'Pi is surfing the data stream', zh: 'Pi 正在顺流而下', tw: 'Pi 正在順流而下' },
  { id: 'Forging', en: 'Pi is forging the changes', zh: 'Pi 正在锻造改动', tw: 'Pi 正在鍛造改動' },
  { id: 'Forming', en: 'Pi is giving it shape', zh: 'Pi 正在塑造雏形', tw: 'Pi 正在塑造雛形' },
  { id: 'Generating', en: 'Pi is generating at full throttle', zh: 'Pi 正在全速生成', tw: 'Pi 正在全速生成' },
  { id: 'Harmonizing', en: 'Pi is harmonizing the edits', zh: 'Pi 正在协调细节', tw: 'Pi 正在協調細節' },
  { id: 'Hashing', en: 'Pi is hashing things out', zh: 'Pi 正在仔细盘算', tw: 'Pi 正在仔細盤算' },
  { id: 'Ideating', en: 'Pi is cooking up ideas', zh: 'Pi 正在烹饪点子', tw: 'Pi 正在烹飪點子' },
  { id: 'Imagining', en: 'Pi is imagining the possibilities', zh: 'Pi 正在畅想可能', tw: 'Pi 正在暢想可能' },
  { id: 'Improvising', en: 'Pi is improvising a fix', zh: 'Pi 正在即兴修复', tw: 'Pi 正在即興修復' },
  { id: 'Incubating', en: 'Pi is incubating a plan', zh: 'Pi 正在孵化方案', tw: 'Pi 正在孵化方案' },
  { id: 'Inferring', en: 'Pi is connecting the dots', zh: 'Pi 正在串联线索', tw: 'Pi 正在串聯線索' },
  { id: 'Infusing', en: 'Pi is infusing fresh knowledge', zh: 'Pi 正在注入新知', tw: 'Pi 正在注入新知' },
  { id: 'Mulling', en: 'Pi is mulling it over', zh: 'Pi 正在反复琢磨', tw: 'Pi 正在反覆琢磨' },
  { id: 'Musing', en: 'Pi is musing over the problem', zh: 'Pi 正在冥思苦想', tw: 'Pi 正在冥思苦想' },
  { id: 'Nesting', en: 'Pi is nesting the pieces in place', zh: 'Pi 正在嵌套归位', tw: 'Pi 正在巢狀歸位' },
  { id: 'Orchestrating', en: 'Pi is orchestrating the moving parts', zh: 'Pi 正在指挥全局', tw: 'Pi 正在掌控全域' },
  { id: 'Percolating', en: 'Pi is letting ideas percolate', zh: 'Pi 正在沉淀想法', tw: 'Pi 正在沉澱想法' },
  { id: 'Perusing', en: 'Pi is perusing the files', zh: 'Pi 正在翻阅文件', tw: 'Pi 正在翻閱檔案' },
  { id: 'Pondering', en: 'Pi is pondering the puzzle', zh: 'Pi 正在思索难题', tw: 'Pi 正在思索難題' },
  { id: 'Processing', en: 'Pi is digesting the data', zh: 'Pi 正在消化数据', tw: 'Pi 正在消化資料' },
  { id: 'Propagating', en: 'Pi is propagating the signal', zh: 'Pi 正在传递信号', tw: 'Pi 正在傳遞訊號' },
  { id: 'Puzzling', en: 'Pi is puzzling it out', zh: 'Pi 正在破解谜题', tw: 'Pi 正在破解謎題' },
  { id: 'Ruminating', en: 'Pi is ruminating on the details', zh: 'Pi 正在深思熟虑', tw: 'Pi 正在深思熟慮' },
  { id: 'Synthesizing', en: 'Pi is synthesizing the insights', zh: 'Pi 正在综合洞见', tw: 'Pi 正在綜合洞見' },
  { id: 'Tempering', en: 'Pi is tempering the rough edges', zh: 'Pi 正在淬火打磨', tw: 'Pi 正在淬火打磨' },
  { id: 'Thinking', en: 'Pi is thinking hard', zh: 'Pi 正在开动脑筋', tw: 'Pi 正在開動腦筋' },
  { id: 'Tinkering', en: 'Pi is tinkering with the tricky bits', zh: 'Pi 正在调试难题', tw: 'Pi 正在偵錯難題' },
  { id: 'Unfurling', en: 'Pi is unfurling the long files', zh: 'Pi 正在展开长卷', tw: 'Pi 正在展開長卷' },
  { id: 'Unravelling', en: 'Pi is unravelling the threads', zh: 'Pi 正在抽丝剥茧', tw: 'Pi 正在抽絲剝繭' },
  { id: 'Working', en: 'Pi is working its magic', zh: 'Pi 正在施展魔法', tw: 'Pi 正在施展魔法' },
  { id: 'Wrangling', en: 'Pi is wrangling the search results', zh: 'Pi 正在收拢线索', tw: 'Pi 正在收攏線索' },
]

/** The step a verb pool is targeted at: reasoning, or a kind of tool call. */
export type SpinnerToolKind = 'read' | 'search' | 'run' | 'write' | 'edit' | 'fetch' | 'other'

export type SpinnerStepContext = { mode: 'thinking' } | { mode: 'tool'; kind: SpinnerToolKind }

/** The frontier is never a tool: reasoning before the first call, or prose. */
export const THINKING_STEP: SpinnerStepContext = { mode: 'thinking' }

const VERB_BY_ID = new Map(SPINNER_VERBS.map((verb) => [verb.id, verb]))

function pool(...ids: string[]): readonly SpinnerVerb[] {
  const verbs = ids.map((id) => {
    const verb = VERB_BY_ID.get(id)
    if (!verb) throw new Error(`Unknown spinner verb: ${id}`)
    return verb
  })
  if (verbs.length === 0) throw new Error('Spinner verb pool must not be empty')
  return verbs
}

/**
 * Pools per step context. Every verb in `SPINNER_VERBS` belongs to at least one
 * pool (overlap is deliberate — "Perusing" fits reading, searching and
 * fetching); the module throws at import time if an id here is misspelled.
 */
const THINKING_POOL = pool(
  'Considering', 'Contemplating', 'Deliberating', 'Determining', 'Envisioning',
  'Ideating', 'Imagining', 'Incubating', 'Inferring', 'Mulling', 'Musing',
  'Percolating', 'Pondering', 'Puzzling', 'Ruminating', 'Synthesizing', 'Thinking'
)

const KIND_POOLS: Record<SpinnerToolKind, readonly SpinnerVerb[]> = {
  read: pool('Deciphering', 'Perusing', 'Processing', 'Unfurling', 'Unravelling'),
  search: pool('Coalescing', 'Deciphering', 'Perusing', 'Unravelling', 'Wrangling'),
  run: pool('Accomplishing', 'Calculating', 'Computing', 'Effecting', 'Hashing', 'Processing', 'Tinkering'),
  write: pool('Composing', 'Crafting', 'Creating', 'Cultivating', 'Forming', 'Generating'),
  edit: pool('Crafting', 'Forging', 'Harmonizing', 'Improvising', 'Tempering'),
  fetch: pool('Cascading', 'Channeling', 'Flowing', 'Infusing', 'Perusing', 'Unfurling'),
  other: pool(
    'Accomplishing', 'Actualizing', 'Architecting', 'Cascading', 'Channeling',
    'Choreographing', 'Coalescing', 'Crystallizing', 'Elucidating', 'Nesting',
    'Orchestrating', 'Propagating', 'Synthesizing', 'Working'
  )
}

export function spinnerVerbPool(ctx: SpinnerStepContext): readonly SpinnerVerb[] {
  return ctx.mode === 'thinking' ? THINKING_POOL : KIND_POOLS[ctx.kind]
}

/**
 * Exact tool name → spinner kind for the tools the app knows, on top of the
 * category registry (`tool-categories.ts`) for the two families it already
 * splits: terminal calls run, `changes` calls edit or write. Only the
 * exploration family needs naming here, because the category registry folds
 * reading, searching and fetching into one group. Anything else (an extension's
 * `mcp`, `todo_write`, a newly installed tool) falls to `other` — the pool that
 * still reads like progress, mirroring how unmapped tools fall back to a
 * generic glyph and stay standalone.
 */
const EXPLORATION_KINDS: Record<string, SpinnerToolKind> = {
  read: 'read',
  ls: 'read',
  grep: 'search',
  find: 'search',
  ffgrep: 'search',
  fffind: 'search',
  web_search: 'search',
  web_fetch: 'fetch'
}

export function spinnerToolKind(toolName: string): SpinnerToolKind {
  const category = toolCategory(toolName)
  if (category?.id === 'terminal') return 'run'
  if (category?.id === 'changes') return toolName === 'write' ? 'write' : 'edit'
  return EXPLORATION_KINDS[toolName] ?? 'other'
}

/**
 * The step a live turn is on: the newest content part of its newest round. A
 * tool call targets that tool's pool; reasoning or (streamed) prose means the
 * model is composing, which reads as thinking. Tool *results* are separate
 * messages and never appear here — a round ending on a tool call keeps that
 * call as the frontier while it runs, which is exactly the interesting case.
 */
export function frontierStepContext(messages: readonly AssistantMsg[]): SpinnerStepContext {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const content = messages[messageIndex].content
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
      const part = content[partIndex]
      if (part.type === 'toolCall') return { mode: 'tool', kind: spinnerToolKind(part.name) }
      if (part.type === 'thinking' || part.type === 'text') return THINKING_STEP
    }
  }
  return THINKING_STEP
}

/**
 * True when the frontier step is a pending ask_user_question call: the turn is
 * suspended on the user's answer, not on work of its own. The waiting row then
 * plays a fixed "waiting for your answer" sentence instead of a verb — the
 * verb pools describe what the AGENT is doing, and while a question is open
 * the honest sentence is that it is waiting on the user. Same walk order as
 * `frontierStepContext`, so the two can never disagree about the frontier.
 */
export function frontierWaitingOnUser(messages: readonly AssistantMsg[]): boolean {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const content = messages[messageIndex].content
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
      const part = content[partIndex]
      if (part.type === 'toolCall') return part.name === ASK_USER_TOOL_NAME
      if (part.type === 'thinking' || part.type === 'text') return false
    }
  }
  return false
}

/** Wall-clock slot index — the only thing allowed to advance the sentence. */
export function spinnerSlotAt(ms: number): number {
  return Math.floor(ms / SPINNER_VERB_INTERVAL_MS)
}

/** FNV-1a 32-bit: deterministic, cheap, good enough spread for word picks. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * The sentence for a slot: pure hash of (seedKey, slot) over the context's pool.
 * Same inputs → same sentence (stable across re-renders and remounts); different
 * seeds and slots get uncorrelated picks.
 */
export function pickSpinnerVerb(ctx: SpinnerStepContext, slot: number, seedKey: string): SpinnerVerb {
  const verbs = spinnerVerbPool(ctx)
  return verbs[hashSeed(`${seedKey}#${slot}`) % verbs.length]
}

/** Localized sentence per locale; English is the fallback for anything else. */
export function spinnerVerbLabel(verb: SpinnerVerb, locale: Locale): string {
  if (locale === 'zh-CN') return verb.zh
  if (locale === 'zh-TW') return verb.tw
  return verb.en
}

// ── preference store (Settings → General) ────────────────────────────────────
//
// A renderer preference like `show-reasoning`/`tool-grouping`: localStorage plus
// a subscribable store, so flipping it in Settings swaps the waiting row on the
// next render with no session reload. Default: on.

const STORAGE_KEY = 'pi-app:spinner-verbs'
const DEFAULT = true

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return DEFAULT
  }
}

let current = DEFAULT
/** Lazily initialized on first read so module import never touches storage. */
let initialized = false

const listeners = new Set<() => void>()

function get(): boolean {
  if (!initialized) {
    current = read()
    initialized = true
  }
  return current
}

function set(next: boolean): void {
  if (get() === next) return
  current = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off')
  } catch {
    /* persistence is best-effort; the in-memory value still applies */
  }
  for (const listener of listeners) listener()
}

/** Subscribable spinner-verb preference shared by the waiting row and Settings. */
export function useSpinnerVerbs(): [boolean, (next: boolean) => void] {
  const enabled = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get
  )
  return [enabled, set]
}

/**
 * The live row's current verb, or null when the mode is off.
 *
 * The verb rotates on wall-clock slots — aligned for every row and every
 * session, so a remount cannot reset the rhythm — and is latched per slot: the
 * step context is sampled at slot boundaries only, so a tool change mid-slot
 * never swaps the sentence. The pick itself is a pure hash of (seedKey, slot),
 * stable across re-renders, and `seedKey` is the session (there is only ever one
 * waiting row on screen, and the same seed keeps the sentence from flipping when
 * the row moves into the live turn).
 */
export function useLiveSpinnerVerb(
  enabled: boolean,
  ctx: SpinnerStepContext,
  seedKey: string
): SpinnerVerb | null {
  // Read through a ref so a step change re-latches on the next slot boundary
  // without restarting the timer (and without being a dependency).
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const [latched, setLatched] = useState<{ slot: number; ctx: SpinnerStepContext }>(() => ({
    slot: spinnerSlotAt(Date.now()),
    ctx
  }))

  useEffect(() => {
    if (!enabled) return
    // Re-latch on (re)enable: the previous latch may belong to an older slot.
    setLatched({ slot: spinnerSlotAt(Date.now()), ctx: ctxRef.current })
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      const now = Date.now()
      timer = setTimeout(() => {
        setLatched({ slot: spinnerSlotAt(Date.now()), ctx: ctxRef.current })
        schedule()
      }, SPINNER_VERB_INTERVAL_MS - (now % SPINNER_VERB_INTERVAL_MS) + 1)
    }
    schedule()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [enabled])

  if (!enabled) return null
  return pickSpinnerVerb(latched.ctx, latched.slot, seedKey)
}
