import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { JSX } from 'react'
import { useTheme } from 'next-themes'
import { Bot, Globe, Plus, X } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { createBrowserPageId, HUMAN_OWNER, buildMarkerUrl, parseMarkerUrl } from '../../../../shared/browser.ts'
import { readOpenBrowserPages, snapshotOpenPages, writeOpenBrowserPages, type OpenBrowserPageEntry } from '@/lib/browser/session'
import { BROWSER_OPEN_LINK_EVENT, drainPendingBrowserOpenLinks } from '@/lib/browser/open-link'
import { getBrowserZoom, nextBrowserZoom, setBrowserZoom } from '@/lib/browser/zoom'
import type { BrowserPanePage, BrowserStore } from '@/lib/browser/store'
import { BrowserPageView, isEditableTarget, type BrowserNavPatch, type BrowserPageActions, type LocalNavInfo } from './BrowserPageView'
import { LabelTooltip } from './LabelTooltip'
import { MiddleEllipsis } from './MiddleEllipsis'

/** Status poll cadence (pi-web BrowserTab parity). pendingCreates are enqueued
 *  WITHOUT a browser:state push, so this poll is what materializes pages the
 *  service is waiting on (agent page creation, the + button's createPage):
 *  rendering the pending row mounts its marker webview, which completes the
 *  registration. The service's own 1s reconcile keeps the registry fresh;
 *  this poll only reads status. */
const BROWSER_POLL_MS = 2_500
/** 本地占位行的寿命：服务端对 pendingCreates 有 TTL，本地行也必须会过期——一个失败/
 *  被丢弃的 popup 或恢复不能留下永久空行（以及它物化出来的空 guest）。 */
const PENDING_ROW_TTL_MS = 20_000
/** 本地占位行的 TTL 清扫节奏（与状态轮询同拍）。 */
const PENDING_ROW_SWEEP_MS = 2_500
/** 恢复/弹窗行的「停在 marker」自愈门槛：navigateTo 声明后超过这个时间仍无进展
 *  （未登记，或已登记但服务端 url 仍是 marker）就采取行动——健康路径登记+导航
 *  ≤2.5s，门槛给了 2 倍余量（症状：收起再展开后某页一直空白，刷新只是重载
 *  marker，新开同 URL 却正常）。 */
const PENDING_NAVIGATE_RETRY_MS = 5_000
/** 自愈里「换 guest」的次数上限：仍未登记且重报无效——guest 一落地就死了
 *  （Invalid guestInstanceId，同批 spawn 竞态，diag4 实测）或 target 对连接不可
 *  见，都只能重挂 webview 换新 target；最多两次，TTL 对最后一个 guest 兜底。 */
const MAX_GUEST_RESTARTS = 2
/** 恢复行 webview 错峰 spawn 的间隔：同批一次性挂载正是死 guest 竞态的触发器
 *  （diag4 实测：三行同挂，一行 Invalid guestInstanceId），错峰从源头规避。 */
const RESTORE_SPAWN_STAGGER_MS = 350

/** A local row materialized by the pane itself (Task 15 popups, and the
 *  first-paint auto-fill) awaiting its dom-ready handshake — NOT a server
 *  pendingCreate (neither calls createPage); it joins the same render
 *  branch below and clears through the self-heal once the server list covers
 *  its tempId (browserSeen registered it state-side). */
interface LocalPendingRow {
  id: string
  owner: string
  /** The target url, reported as navigateTo in the seen handshake — absent
   *  for a blank page (no navigation for the service to perform). */
  navigateTo?: string
}
/** The ONE pending-materialization row shape (Ruling D): server pendingCreates
 *  and Task 15's local popup rows both become this row — its marker src is
 *  what mounts the webview that completes the registration. No second render
 *  path for "pending page → marker webview" exists. */
const pendingRowOf = (id: string, owner: string, navigateTo?: string): BrowserPanePage => ({
  id,
  owner,
  url: buildMarkerUrl(owner, id),
  title: '',
  agentBusy: false,
  crashed: false,
  pending: true,
  navigateTo
})

/** Display url of a page row: localNav truth first, server meta as fallback;
 *  markers (the hosting convention, not a user-facing location) read as
 *  about:blank. */
const displayUrlOf = (page: Pick<BrowserPanePage, 'url'>, nav?: LocalNavInfo): string => {
  const raw = nav?.url || page.url
  return parseMarkerUrl(raw) ? 'about:blank' : raw
}

/** Fold one webview event patch into the localNav map (pure; returns the same
 *  reference when nothing changed so setLocalNav skips the render). */
function applyNavPatch(
  prev: Record<string, LocalNavInfo>,
  id: string,
  patch: BrowserNavPatch
): Record<string, LocalNavInfo> {
  const current = prev[id]
  const next: LocalNavInfo = {
    url: patch.url ?? current?.url ?? '',
    title: patch.title ?? current?.title ?? '',
    favicon: patch.favicon === undefined ? current?.favicon : (patch.favicon ?? undefined)
  }
  if (
    current &&
    current.url === next.url &&
    current.title === next.title &&
    current.favicon === next.favicon
  ) return prev
  return { ...prev, [id]: next }
}

/**
 * The embedded browser pane: a page strip (beUI segment tabs) over one
 * always-mounted webview per page, with the consent gate in front. Data flows
 * in through the workspace-owned `BrowserStore` (`browser:state` pushes + the
 * poll below); display truth for titles/URLs/favicons is this pane's own
 * `localNav` map, fed by webview events (server meta is only the fallback).
 *
 * `active` (threaded by SidebarPanel's keep-alive layer) is true only while
 * this pane's rail tab is the one on screen: the pane-wide ⌘±/0 zoom and
 * ⌘F/⌘P find/print shortcuts register only then, so the hidden keep-alive
 * layer never consumes them.
 */
export function BrowserPane({
  store,
  onEmpty,
  active
}: {
  store: BrowserStore
  onEmpty: () => void
  active: boolean
}): JSX.Element {
  const { t } = useI18n()
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const status = state.status
  /** Consent gates page creation (the open-link drain below relies on this:
   *  before consent, createPage rejects and a consumed URL is simply lost).
   *  An unknown status counts as "consent pending", so nothing is consumed
   *  before the first status read lands. */
  const consentRequired = status?.consentRequired ?? true
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
  /** Pages with a close round-trip in flight: their rows (and webviews) go
   *  away immediately instead of waiting for the next status push. */
  const [closedIds, setClosedIds] = useState<ReadonlySet<string>>(() => new Set())
  /** UI-side nav truth per page id (webview events; server meta falls back). */
  const [localNav, setLocalNav] = useState<Record<string, LocalNavInfo>>({})
  /** Task 15: local popup rows materializing through the shared pending branch
   *  above. Appended by the popup drain; each row's webview reports itself via
   *  the dom-ready handshake (browserSeen with navigateTo) and the row clears
   *  in the self-heal once the server list covers the tempId. */
  const [localPending, setLocalPending] = useState<LocalPendingRow[]>([])
  /** 自愈台阶二的 guest 重挂计数：id → 已重挂数。BrowserPageView 以它作 webview
 *  的 key——变化即销毁旧 guest（它对服务的 CDP 连接不可见，重报救不回）重挂新
 *  target，同 marker id 干净地 attach 后由已存的 pendingNavigate 导航到位。 */
  const [guestRestarts, setGuestRestarts] = useState<Record<string, number>>({})
  /** 本地占位行的创建时刻（TTL 清理用）。 */
  const localPendingAtRef = useRef(new Map<string, number>())
  /** 带待导航（navigateTo）的本地行的自愈登记：id → owner/target/创建时刻。一个
 *  恢复/弹窗行的 guest 若因 seen 被入口守卫丢弃、登记后的 goto 失败（20s
 *  domcontentloaded 超时被吞）或登记迟到而一直停在 marker，sweep 重报 seen 治愈。 */
  const localPendingNavRef = useRef(new Map<string, { owner: string; navigateTo: string; at: number; attempts: number; restarts: number }>())
  /** 恢复行的 webview 错峰 spawn 延迟（id → ms）：条面仍一次性画齐，只有 guest
 *  的诞生错开——同批挂载会以约一半概率弄死一个 guest（Invalid guestInstanceId）。 */
  const restoreSpawnDelaysRef = useRef(new Map<string, number>())
  /** Task 15: webContentsId → page ownership, recorded at each page's dom-ready
   *  handshake (where the id is read) and consulted when a `browser:popup`
   *  arrives, so an opener's owner is inherited (an agent page's popup stays
   *  agent-owned). Entries leave with their page (prune effect below); the
   *  pane's unmount drops the whole instance-scoped map. */
  const wcIdMapRef = useRef(new Map<number, { id: string; owner: string }>())
  const registerWebContentsId = useCallback((webContentsId: number, id: string, owner: string) => {
    wcIdMapRef.current.set(webContentsId, { id, owner })
  }, [])
  useEffect(() => () => { wcIdMapRef.current.clear() }, [])
  /** Set while our createPage round trip is in flight: the first fresh
   *  pendingCreate row that shows up is ours to select. */
  const awaitingCreateRef = useRef(false)
  // ---- Task 8: first-status latch / open-pages restore / empty transition ----
  // Status snapshot that predates THIS mount: the workspace-owned store keeps
  // its last value across a rail collapse (which unmounts this pane and kills
  // its webviews — every registry page is hosted by a webview in THIS pane, so
  // a pre-mount status describes a world whose guests are all dead). The
  // latch, the empty transition, the snapshot write AND the page model itself
  // (see `pages`) consume only statuses that arrived after the mount — a stale
  // snapshot reading as non-empty must never suppress a restore, and its dead
  // rows must never render.
  const staleStatusRef = useRef(status)
  /** First-status latch: fired (or deliberately skipped) once per mount. */
  const autoFilledRef = useRef(false)
  /** A restore sits between its ensure-call and its row materialization: the
   *  snapshot write must NOT run in that window — a fresh EMPTY status (the
   *  sweep of the dead pre-fold pages landing after a fast expand) would
   * blank the snapshot the restore is about to read (measured race: the
   * strip then restored to a single blank tab). */
  const restoreInFlightRef = useRef(false)
  /** A post-mount status has shown a non-empty merged model. */
  const sawPagesRef = useRef(false)
  /** onEmpty at most once per mount (closePage and the transition share it). */
  const emptyFiredRef = useRef(false)
  /** False once this pane instance unmounted: the store is shared with the
   *  workspace and outlives the pane, so a createPage round trip that settles
   *  after the unmount must not write its optimistic row for a pane that will
   *  never mount it. */
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const { resolvedTheme } = useTheme()
  // Guest pages follow the app theme: main injects Emulation.setEmulatedMedia
  // per registered page and replays it on every registration, so this one
  // call — on mount and on each resolvedTheme change — covers every current
  // and future guest. Errors are swallowed across the bridge. Skip until
  // next-themes has resolved: resolvedTheme is undefined during its
  // pre-resolution pass, and sending 'light' there would emulate the wrong
  // scheme for one frame in a dark app.
  useEffect(() => {
    if (!resolvedTheme) return
    void window.pi.browserTheme(resolvedTheme === 'dark' ? 'dark' : 'light')
  }, [resolvedTheme])

  // ONE zoom action shared by both shortcut paths (the window capture listener
  // below and the guest relay from main): key → ladder step. The store change
  // fans out through the shared pageZoom subscription, so every mounted page
  // view re-applies its guest's factor.
  const handleZoomShortcut = useCallback((key: string): boolean => {
    let next: number | null = null
    if (key === '=' || key === '+') next = nextBrowserZoom(getBrowserZoom(), 1)
    else if (key === '-') next = nextBrowserZoom(getBrowserZoom(), -1)
    else if (key === '0') next = 1 // reset → 100%
    if (next === null) return false
    setBrowserZoom(next)
    return true
  }, [])

  // ⌘= (also ⌘+) / ⌘- / ⌘0 page zoom, Chromium parity. Registered ONLY while
  // this pane's rail tab is the active one: the keep-alive layer stays
  // mounted under every other tab and must not consume the shortcuts, and
  // capture-phase preventDefault + stopPropagation keep the app's own ⌘
  // handlers (and the composer's fields) out of the same keystroke. Fields
  // keep their keys: isEditableTarget skips text-entry targets. Non-US
  // layouts spell different characters over the same physical keys, so the
  // physical `code` spellings (Equal/Minus/Digit0) are the fallback; numpad
  // keys keep working through `key`.
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const key =
        event.key === '=' || event.key === '+' || event.key === '-' || event.key === '0'
          ? event.key
          : event.code === 'Equal'
            ? '='
            : event.code === 'Minus'
              ? '-'
              : event.code === 'Digit0'
                ? '0'
                : null
      if (key === null) return
      if (isEditableTarget(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      handleZoomShortcut(key)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active, handleZoomShortcut])

  // The selected page's find/print surface. BrowserPageView (only the
  // selected one binds) registers its actions here, so the pane-level ⌘F/⌘P
  // below and the guest relay act on the page on screen without the pane
  // reaching into any webview element itself.
  // T13: menu opens find via this path (⋮ entry → selectedPageActionsRef.current?.openFind()).
  const selectedPageActionsRef = useRef<BrowserPageActions | null>(null)
  const bindPageActions = useCallback((actions: BrowserPageActions | null) => {
    selectedPageActionsRef.current = actions
  }, [])

  // ⌘F / ⌘P — browser-owned chrome (Ruling M): the selected page's find bar
  // and print dialog. Same gate as the zoom shortcuts: only while this
  // pane's rail tab is the active one, editable targets yield (the find
  // field's own ⌘F = next match), capture-phase preventDefault +
  // stopPropagation keep the app's own ⌘ handlers out of the same keystroke.
  // Physical `code` spellings (KeyF/KeyP) are the fallback for non-US
  // layouts, mirroring the zoom listener above.
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const key =
        event.key === 'f' || event.key === 'p'
          ? event.key
          : event.code === 'KeyF'
            ? 'f'
            : event.code === 'KeyP'
              ? 'p'
              : null
      if (key === null) return
      if (isEditableTarget(event.target)) return
      const actions = selectedPageActionsRef.current
      if (!actions) return
      event.preventDefault()
      event.stopPropagation()
      if (key === 'f') actions.openFind()
      else actions.print()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active])

  // Guest-focused browser-owned keys (Ruling M): ⌘±/0 zoom plus ⌘F find and
  // ⌘P print, intercepted by main before the guest acts on them (wiring.ts
  // before-input-event, allowlist exactly these six) and relayed here. No
  // editable-target guard on this path — a browser-owned key wins even while a
  // field inside the page is focused (Chromium parity) — but the relay IS gated
  // on this pane's rail tab being on screen: a guest under the hidden keep-alive
  // layer can still hold focus, and acting there would change the global zoom or
  // open a find bar nobody can see.
  useEffect(() => {
    return window.pi.onBrowserGuestShortcut(({ key }) => {
      if (!active) return
      if (handleZoomShortcut(key)) return
      if (key === 'f') selectedPageActionsRef.current?.openFind()
      else if (key === 'p') selectedPageActionsRef.current?.print()
    })
  }, [active, handleZoomShortcut])

  // Agent 键盘动作前的聚焦握手（main 等到 ack 才派按键）。为什么必须在这里做：CDP 派给
  // guest 的按键会先交给窗口当前聚焦的 widget——壳窗口持焦点时它会同时出现在壳窗口 DOM，
  // 于是 agent 按一次 Esc（Composer 的停止键）就把本轮停掉；实测只有 `<webview>` 元素拿到
  // DOM 焦点才彻底隔开，main 侧 `webContents.focus()` 与 `Page.bringToFront` 都不动壳窗口
  // 的 DOM 焦点。按 wcId 找元素（与 dom-ready 上报同一条链路），找不到也要 ack——
  // 焦点给不了时退回旧行为，但绝不能把一次键盘动作卡住。
  useEffect(() => {
    return window.pi.onBrowserFocusGuest(({ webContentsId, requestId }) => {
      const elements = [...document.querySelectorAll('webview')] as unknown as Array<{
        getWebContentsId?: () => number
        focus: () => void
      }>
      const element = elements.find((candidate) => {
        try { return candidate.getWebContentsId?.() === webContentsId } catch { return false }
      })
      element?.focus()
      void window.pi.browserFocusGuestDone(requestId)
    })
  }, [])

  // Workspace wiring keeps the store fed; this pane owns the poll (a closed
  // tab has no webviews to host, so pendingCreates may simply time out).
  useEffect(() => {
    void window.pi.browserStatus().then((next) => store.applyStatus(next)).catch(() => {})
    const timer = setInterval(() => {
      void window.pi.browserStatus().then((next) => store.applyStatus(next)).catch(() => {})
    }, BROWSER_POLL_MS)
    return () => clearInterval(timer)
  }, [store])

  // Merged page model (pi-web BrowserTab semantics): serverPages ∪
  // pendingCreates(物化为 pending 行) ∪ localPending(Task 15 popups + 快照恢复行) ∪
  // optimistic − closedIds. Identify optimistic pages by MEMBERSHIP in
  // state.optimistic (T6-①), never by reading `pending === false` as
  // "materialized".
  // The MOUNT-TIME status is a dead world (staleStatusRef): its pages and
  // pendingCreates render as NOTHING. Rendering them painted rows whose
  // webviews sat at their marker forever (nothing re-navigates a server row)
  // until the service sweep dropped them — the blank-then-reload interlude a
  // rail fold used to show. The restore rows below take their place in the
  // same commit.
  const pages = useMemo<BrowserPanePage[]>(() => {
    if (!status) return []
    const live = status !== staleStatusRef.current
    const serverPages = live ? status.pages : []
    const known = new Set(serverPages.map((page) => page.id))
    // ONE materialization branch (Ruling D): server pendingCreates AND local
    // popup/restore rows become pending rows through the same `pendingRowOf`
    // shape — rendering the marker webview is what completes their
    // registration, so there is exactly one render path for "pending page →
    // marker webview".
    const pending = [
      ...(live ? status.pendingCreates : [])
        .filter((entry) => !known.has(entry.id))
        .map((entry) => pendingRowOf(entry.id, entry.owner)),
      ...localPending
        .filter((row) => !known.has(row.id))
        .map((row) => pendingRowOf(row.id, row.owner, row.navigateTo))
    ]
    for (const page of pending) known.add(page.id)
    return [...serverPages, ...pending, ...state.optimistic.filter((page) => !known.has(page.id))]
      .filter((page) => !closedIds.has(page.id))
  }, [state, status, closedIds, localPending])

  // Selection falls back to the first page during render (a selected page was
  // closed/vanished): deriving here avoids an effect-chasing empty frame.
  const effectiveSelectedId =
    selectedPageId && pages.some((page) => page.id === selectedPageId)
      ? selectedPageId
      : (pages[0]?.id ?? null)

  // pages mirror for event handlers (close reads it without a stale closure).
  const pagesRef = useRef(pages)
  useEffect(() => { pagesRef.current = pages }, [pages])
  // selection mirror for the same reason (closePage reads the live selection
  // without a stale closure).
  const selectedIdRef = useRef<string | null>(effectiveSelectedId)
  useEffect(() => { selectedIdRef.current = effectiveSelectedId }, [effectiveSelectedId])
  // onEmpty through a ref: the pane's callbacks keep stable identities.
  const onEmptyRef = useRef(onEmpty)
  useEffect(() => { onEmptyRef.current = onEmpty }, [onEmpty])

  // Self-heal the optimistic rows (T6-②): once the server list covers an
  // optimistic id, the placeholder's job is done — pi-web's refresh prunes
  // its localPages the same way. The same pass clears Task 15's local popup
  // rows once the server list covers their tempId (browserSeen registered
  // them state-side — the server row replaces the placeholder), and prunes
  // close tombstones for ids that fully left the registry (pages AND
  // pendingCreates — a pending row stays hidden until its waiter resolves).
  useEffect(() => {
    if (!status) return
    const known = new Set(status.pages.map((page) => page.id))
    for (const page of state.optimistic) {
      if (known.has(page.id)) store.removeOptimistic(page.id)
    }
    setLocalPending((prev) => {
      const remaining = prev.filter((row) => !known.has(row.id))
      return remaining.length === prev.length ? prev : remaining
    })
    for (const id of known) localPendingAtRef.current.delete(id)
    const pendingIds = new Set(status.pendingCreates.map((entry) => entry.id))
    setClosedIds((prev) => {
      const remaining = [...prev].filter((id) => known.has(id) || pendingIds.has(id))
      return remaining.length === prev.size ? prev : new Set(remaining)
    })
  }, [state, status, store])

  useEffect(() => {
    const ids = new Set(pages.map((page) => page.id))
    setLocalNav((prev) => {
      const stale = Object.keys(prev).filter((id) => !ids.has(id))
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const id of stale) delete next[id]
      return next
    })
    // Task 15: drop wcId→page entries whose page left the model (close/swap) —
    // a stale entry would misattribute a future popup to a closed page's
    // owner instead of falling back to human.
    for (const [wcId, info] of wcIdMapRef.current) {
      if (!ids.has(info.id)) wcIdMapRef.current.delete(wcId)
    }
  }, [pages])

  // First fresh pendingCreate after our + click is ours: select the row as
  // soon as it materializes (createPage's own resolution re-selects the same
  // id a moment later — the reconcile upgrade needs a beat).
  useEffect(() => {
    if (!awaitingCreateRef.current || !status) return
    const fresh = status.pendingCreates.find((entry) => !closedIds.has(entry.id))
    if (!fresh) return
    awaitingCreateRef.current = false
    setSelectedPageId(fresh.id)
  }, [state, status, closedIds])

  // onEmpty at most once per pane mount: closePage's direct call and the
  // empty-after-first-status transition share this guard.
  const fireEmpty = useCallback(() => {
    if (emptyFiredRef.current) return
    emptyFiredRef.current = true
    onEmptyRef.current()
  }, [])

  const handleNavChange = useCallback((id: string, patch: BrowserNavPatch) => {
    setLocalNav((prev) => applyNavPatch(prev, id, patch))
  }, [])

  // The previous pane instance's optimistic rows died with it: their
  // createPage round trips belonged to callbacks of a component that no
  // longer exists, and an uncovered placeholder would render forever (its id
  // never joins a server list again — see `pages`). A fresh mount owns no
  // in-flight round trips, so clear the deck before anything decides on it.
  useEffect(() => { store.clearOptimistic() }, [store])

  /** Materialize the open-pages snapshot as local pending rows (the popup
   *  path verbatim: a fresh id + marker src + navigateTo — the service
   *  performs the goto after registration). Rows carry the snapshot entry's
   *  OWNER: a restored agent page registers under `agent:<sessionId>` again,
   *  so its session's tools find it again through activeByOwner. The strip
   *  prewrites each destination url and reselects the snapshotted active tab,
   *  so the restored strip paints within one round trip — the only wait left
   *  is the guests reloading their content.
   *  ENSURE-FIRST (measured, iron 7): the local-row mechanism only works for
   *  guests that spawn AFTER the service's CDP connection exists — a guest
   *  predating the connection is invisible to it forever (state-only, no
   *  runtime: the pendingNavigate goto never runs and the theme emulation
   *  never reaches it — exactly how a cold-boot restore broke the theme leg).
   *  So the connection is awaited BEFORE any marker webview mounts; once the
   *  service is up (the rail-fold case, the common one) this resolves on the
   *  next tick and the strip still paints at once. A failed connect still
   *  materializes the rows — they show their urls, and the TTL sweep reaps
   *  what could not register. */
  const restoreOpenPages = useCallback(() => {
    // Set SYNCHRONOUSLY, before any status push can arrive: the snapshot
    // write is fenced off until the rows exist (see restoreInFlightRef).
    restoreInFlightRef.current = true
    void window.pi.browserEnsureService()
      .catch(() => { /* rows still materialize; the TTL sweep reaps unregistered ones */ })
      .then(() => {
        const saved = readOpenBrowserPages()
        const targets: ReadonlyArray<OpenBrowserPageEntry> =
          saved.length > 0 ? saved : [{ owner: HUMAN_OWNER }]
        const rows = targets.map((entry) => pendingRowOf(createBrowserPageId(), entry.owner, entry.url))
        // 错峰 spawn：条面一次性画齐（行/URL/名字都在），只有 webview 的 src 延后
        // 落地——同批一次性挂载是死 guest 竞态的触发器（见 restoreSpawnDelaysRef）。
        restoreSpawnDelaysRef.current = new Map(rows.map((row, index) => [row.id, Math.min(index, 8) * RESTORE_SPAWN_STAGGER_MS]))
        setLocalPending((prev) => [...prev, ...rows])
        for (const row of rows) {
          localPendingAtRef.current.set(row.id, Date.now())
          if (row.navigateTo) localPendingNavRef.current.set(row.id, { owner: row.owner, navigateTo: row.navigateTo, at: Date.now(), attempts: 0, restarts: 0 })
        }
        // Prewrite url AND title/favicon: the strip must show the folded-away
        // tabs exactly as they were (names, not raw urls) from the first
        // commit; the loaded page's own events refresh them afterwards. A
        // url-less entry (blank tab) keeps its about:blank display semantics.
        setLocalNav((prev) => {
          let next = prev
          for (let i = 0; i < targets.length; i++) {
            const entry = targets[i]
            if (!entry.url && !entry.title && !entry.favicon) continue
            next = applyNavPatch(next, rows[i].id, { url: entry.url, title: entry.title, favicon: entry.favicon })
          }
          return next
        })
        const selected = targets.findIndex((entry) => entry.selected)
        setSelectedPageId(rows[selected >= 0 ? selected : 0].id)
        restoreInFlightRef.current = false
      })
  }, [])

  // First-paint auto-fill (mount-once): decide from LOCAL knowledge before
  // any server round trip — the restore rows and their marker webviews render
  // in the pane's FIRST commit, so reopening the tab (or expanding a folded
  // rail) shows the previous strip at once: urls prewritten, count, order and
  // active tab intact, the wait being only the guests reloading their content.
  // The pre-mount status is a DEAD world (staleStatusRef) and never a reason
  // to decline — a rail collapse kills every guest with the pane, so its rows
  // cannot come back. Only a consent gate we KNOW is closed, or a live popup
  // queue still waiting to materialize, keep the latch armed below. A null
  // status is unknown, not closed: rows materialize behind the consent card
  // and are simply there when the grant lifts it.
  useEffect(() => {
    if (autoFilledRef.current) return
    const storeState = store.getState()
    if (storeState.popups.length > 0) return
    if (storeState.status?.consentRequired) return
    autoFilledRef.current = true
    restoreOpenPages()
  }, [restoreOpenPages])

  // Status-latch fallback (once per mount, for the cases first-paint
  // declined): the FIRST FRESH status with consent past and an empty model
  // restores the snapshot the same way. Live arrivals win — a fresh status
  // that already carries pages/pendingCreates (an agent createPage that
  // auto-opened the rail, queued popups already materialized) skips the
  // restore.
  useEffect(() => {
    if (autoFilledRef.current) return
    if (!status || status === staleStatusRef.current) return
    if (status.consentRequired) return
    autoFilledRef.current = true
    if (pages.length > 0 || status.pendingCreates.length > 0 || store.getState().optimistic.length > 0) return
    restoreOpenPages()
  }, [pages, status, store, restoreOpenPages])

  // Empty after the first real status (pointer T7-④): once the merged model
  // HAS been non-empty post-mount, it going empty for ANY reason — server-side
  // removal, crash sweep — closes the tab, exactly like the close button.
  // Boot (no status, or the stale pre-mount snapshot) never counts; a restore
  // in flight never counts either — its rows ARE the model from their first
  // commit, so there is no async window of legitimate emptiness to own.
  useEffect(() => {
    if (!status || status === staleStatusRef.current || status.consentRequired) return
    if (pages.length > 0) {
      sawPagesRef.current = true
      return
    }
    if (!sawPagesRef.current || emptyFiredRef.current) return
    fireEmpty()
  }, [fireEmpty, pages, status])

  // Continuous open-pages snapshot (Task 8): every merged-model/localNav
  // change rewrites the snapshot — ALL owners and ALL pages (blank tabs
  // included, so the count and order survive a fold exactly), each entry
  // carrying its display url, TITLE and favicon plus the active-tab marker;
  // the write inside session.ts skips same-value writes. Skipped before the
  // first FRESH status, and while a restore is in flight, so this effect can
  // never blank the snapshot a restore is about to read; restore rows carry
  // their urls/titles from their first commit, so the rewrite they trigger
  // is a same-value write.
  useEffect(() => {
    if (!status || status === staleStatusRef.current) return
    if (restoreInFlightRef.current) return
    writeOpenBrowserPages(
      snapshotOpenPages(
        pages.map((page) => {
          const nav = localNav[page.id]
          return {
            owner: page.owner,
            url: displayUrlOf(page, nav),
            id: page.id,
            title: nav?.title || page.title || undefined,
            favicon: typeof nav?.favicon === 'string' ? nav.favicon : undefined
          }
        }),
        effectiveSelectedId
      )
    )
  }, [localNav, pages, status, effectiveSelectedId])

  const newPage = useCallback(() => {
    awaitingCreateRef.current = true
    // Pull once right away: the pendingCreate enqueue does not push state, so
    // the poll alone would add up to one BROWSER_POLL_MS of dead air.
    void window.pi.browserStatus().then((next) => store.applyStatus(next)).catch(() => {})
    void window.pi.browserCreatePage()
      .then((meta) => {
        awaitingCreateRef.current = false
        // The pane unmounted mid-round-trip (rail fold / tab close): the store
        // outlives this instance, so without the guard the resolved page's
        // optimistic row would leak into a pane that never mounts it.
        if (!aliveRef.current) return
        setSelectedPageId(meta.id)
        // Round trip done — the registry has the page. If the push is still
        // in flight, an optimistic row keeps the strip from flashing; the
        // self-heal above drops it once the server list covers the id.
        if (!store.getState().status?.pages.some((page) => page.id === meta.id)) {
          store.addOptimistic(meta.id)
          store.resolveOptimistic(meta.id)
        }
      })
      .catch(() => { awaitingCreateRef.current = false })
  }, [store])

  const grantConsent = useCallback(() => {
    void window.pi.browserConsent()
      .then((next) => store.applyStatus(next))
      .catch(() => { /* the next push carries the granted state */ })
  }, [store])

  const closePage = useCallback((id: string) => {
    // Closing the last page closes the whole browser tab (terminal-tab
    // behaviour); the server close is idempotent either way.
    const wasLast = pagesRef.current.length <= 1
    // Closing the SELECTED tab returns to the tab selected when it was OPENED
    // (the Chrome rule); when that opener is gone, to the first tab to its
    // LEFT (rightmost fallback keeps the reading order). Closing a background
    // tab leaves the selection untouched — the render fallback (first row)
    // stays as the last resort only.
    if (!wasLast && selectedIdRef.current === id) {
      const list = pagesRef.current
      const idx = list.findIndex((page) => page.id === id)
      const opener = openersRef.current.get(id)
      let target: string | null = null
      if (opener && opener !== id && list.some((page) => page.id === opener)) target = opener
      for (let i = idx - 1; target === null && i >= 0; i -= 1) target = list[i].id
      for (let i = idx + 1; target === null && i < list.length; i += 1) target = list[i].id
      if (target) setSelectedPageId(target)
    }
    setClosedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
    setLocalNav((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    // A local popup row closed before its handshake must not resurrect: the
    // closedIds tombstone self-heals away once the id leaves the registry,
    // which would re-expose the row — drop it outright (removeOptimistic's
    // mirror for the Task 15 queue).
    setLocalPending((prev) => {
      if (!prev.some((row) => row.id === id)) return prev
      return prev.filter((row) => row.id !== id)
    })
    localPendingNavRef.current.delete(id)
    store.removeOptimistic(id)
    void window.pi.browserClosePage(id).catch(() => { /* idempotent cleanup */ })
    if (wasLast) fireEmpty()
  }, [fireEmpty, store])

  // 本地占位行的 TTL 清扫：PENDING_ROW_TTL_MS 的承诺此前只有常量没有执行者。
  // 快照恢复行也走 localPending 之后必须兑现——服务不可用/登记失败时，一个占位
  // 行不能连同它物化出来的空 guest 永久留在条上。已登记的行在自愈 effect 里随
  // server 列表覆盖删除时间戳，不会误伤；清走走的是 closePage（同步摘行 +
  // idempotent 的服务端满理），最后一行过期同样触发 onEmpty，与手工关闭一致。
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      for (const [id, at] of [...localPendingAtRef.current.entries()]) {
        if (now - at > PENDING_ROW_TTL_MS) closePage(id)
      }
      // 停在 marker 的自愈（两级）：服务端 url 仍是 marker（或未登记）就是这个形态。
      // 台阶一（重报 seen）：已登记 → existing 分支立即 goto；未登记 → 新条目重存
      // pendingNavigate 等 reconcile 消费。台阶二（换 guest）：仍未登记说明 guest
      // 一落地就死了（Invalid guestInstanceId——同批 spawn 竞态，diag4 实测：重报
      // 治不了，元素里的 guest 引用已指向死实例）或 target 对连接不可见——重挂
      // webview（同 marker id 的新 target 干净地 attach，重握手 + 已存
      // pendingNavigate 导航到位），≤MAX_GUEST_RESTARTS 次，每次重置时钟，TTL 对
      // 最后一个 guest 兜底。导航成功（服务端 url 非 marker）或行离开模型即清册。
      const serverPages = store.getState().status?.pages ?? []
      for (const [id, meta] of [...localPendingNavRef.current.entries()]) {
        if (!pagesRef.current.some((page) => page.id === id)) {
          localPendingNavRef.current.delete(id)
          setGuestRestarts((prev) => {
            if (!(id in prev)) return prev
            const next = { ...prev }
            delete next[id]
            return next
          })
          continue
        }
        const serverRow = serverPages.find((page) => page.id === id)
        if (serverRow && !parseMarkerUrl(serverRow.url)) {
          localPendingNavRef.current.delete(id)
          continue
        }
        if (now - meta.at < PENDING_NAVIGATE_RETRY_MS) continue
        meta.attempts += 1
        void window.pi.browserSeen({
          id,
          owner: meta.owner,
          url: buildMarkerUrl(meta.owner, id),
          navigateTo: meta.navigateTo
        }).catch(() => { /* 下一轮 sweep 再试；台阶二/TTL 兜底 */ })
        if (!serverRow && meta.restarts < MAX_GUEST_RESTARTS) {
          meta.at = now
          meta.restarts += 1
          localPendingAtRef.current.set(id, now)
          setGuestRestarts((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }))
        }
      }
    }, PENDING_ROW_SWEEP_MS)
    return () => clearInterval(timer)
  }, [closePage, store])

  // ---- Task 15: chat open-link + popup drains ----

  /** Open-link drain path: the human-owner standard createPage (its own
   *  pendingCreate handshake), then select the new page and prewrite the
   *  strip's destination (T8 prewrite, same guard as the restore latch — a
   *  did-navigate that landed first wins). A rejection (consent gate in
   *  front, host gone) drops the url like the restore latch does; the pane's
   *  own consent/empty state is the fallback surface. */
  const openLinkInNewPage = useCallback((url: string) => {
    void window.pi.browserCreatePage(url)
      .then((meta) => {
        setSelectedPageId(meta.id)
        setLocalNav((prev) => {
          const shown = prev[meta.id]?.url ?? ''
          if (shown && shown !== 'about:blank' && !parseMarkerUrl(shown)) return prev
          return applyNavPatch(prev, meta.id, { url })
        })
      })
      .catch(() => { /* nothing to host it — the consent/empty state shows */ })
  }, [])

  /** Popup materialization (the corrected flow): never `browserCreatePage` —
   *  a CLIENT-SIDE tempId plus a local pending row through the same Ruling D
   *  branch. That row's marker webview reports browserSeen({ id: tempId,
   *  owner, url: <marker>, webContentsId, navigateTo }) on its dom-ready; the
   *  service registers state + pendingNavigate, the reconcile upgrades the
   *  page to runtime, and the SERVICE performs the goto. The renderer never
   *  loadURLs a popup itself — it would lose the marker race and the page
   *  would never register. */
  const materializePopups = useCallback(() => {
    const drained = store.drainPopups()
    if (drained.length === 0) return
    for (const popup of drained) {
      // Owner inheritance via the wcId map: the opener's live page wins; an
      // opener already gone (its row left the model, the map pruned) falls
      // back to human.
      const owner = wcIdMapRef.current.get(popup.openerWebContentsId)?.owner ?? HUMAN_OWNER
      const tempId = createBrowserPageId()
      setLocalPending((prev) => [...prev, { id: tempId, owner, navigateTo: popup.url }])
      localPendingAtRef.current.set(tempId, Date.now())
      localPendingNavRef.current.set(tempId, { owner, navigateTo: popup.url, at: Date.now(), attempts: 0, restarts: 0 })
      // Prewrite the strip's destination (applyNavPatch over a fresh id) so
      // the row reads as the target page instead of about:blank/loading.
      setLocalNav((prev) => applyNavPatch(prev, tempId, { url: popup.url }))
      setSelectedPageId(tempId)
    }
  }, [store])

  // Open-link drain: on mount (backstop for clicks that happened before this
  // pane existed — Workspace only opens the tab) and on every event while
  // mounted (the pane is up — drain immediately).
  useEffect(() => {
    const drain = () => {
      // Draining before consent would consume the queue and then drop every URL
      // on ConsentRequiredError — the link the user clicked would vanish. Leave
      // the queue alone; granting consent flips `consentRequired`, which re-runs
      // this effect and drains it then.
      if (consentRequired) return
      const urls = drainPendingBrowserOpenLinks()
      if (urls.length === 0) return
      for (const url of urls) openLinkInNewPage(url)
      // Pull once right away: the pendingCreate enqueue does not push state,
      // so the poll alone would add up to one BROWSER_POLL_MS of dead air
      // (same trick as newPage).
      void window.pi.browserStatus().then((next) => store.applyStatus(next)).catch(() => {})
    }
    drain()
    window.addEventListener(BROWSER_OPEN_LINK_EVENT, drain)
    return () => window.removeEventListener(BROWSER_OPEN_LINK_EVENT, drain)
  }, [consentRequired, openLinkInNewPage, store])

  // Popup drain: on mount (popups queued while the pane was closed survive in
  // the store) and whenever the queue is non-empty while mounted — including
  // the hidden keep-alive layer under another rail tab. drainPopups clears
  // the queue, so the empty re-run is a no-op.
  useEffect(() => {
    materializePopups()
  }, [materializePopups, state.popups])

  // Follow-new-tab scrolling: when the strip overflows, a newly added tab (a
  // + tab, a link popup, an agent page) scrolls into view — the selected new
  // row when there is one (a + tab opens selected), else the last added.
  // Closing rows never scrolls. The pane's first mount after a fold/expand
  // sees every restored row as new, which also brings the ACTIVE tab back
  // into view. A followed row can keep GROWING after its scroll (a blank
  // tab's "about:blank" label becomes the page title): a ResizeObserver on
  // the strip content re-scrolls the target while the follow lives, and a
  // manual scroll (wheel/drag — clicking a row included) cancels the follow.
  const stripScrollRef = useRef<HTMLDivElement | null>(null)
  const stripIdsRef = useRef<string[]>([])
  const followTabIdRef = useRef<string | null>(null)
  // Tab-close return bookkeeping: each tab remembers the page selected at the
  // moment it APPEARED (closing it returns there); rows that leave the strip
  // drop their entry.
  const openersRef = useRef<Map<string, string | null>>(new Map())
  const prevSelectedRef = useRef<string | null>(effectiveSelectedId)
  const scrollFollowIntoView = useCallback(() => {
    const scroller = stripScrollRef.current
    const targetId = followTabIdRef.current
    if (!scroller || !targetId) return
    const row = scroller.querySelector<HTMLElement>(`[data-browser-tab="${targetId.replace(/"/g, '\\"')}"]`)
    if (!row) return
    const overflow = row.getBoundingClientRect().right - scroller.getBoundingClientRect().right + 8
    if (overflow > 0) scroller.scrollLeft += overflow
  }, [])
  useEffect(() => {
    const ids = pages.map((page) => page.id)
    const prev = stripIdsRef.current
    stripIdsRef.current = ids
    if (followTabIdRef.current && !ids.includes(followTabIdRef.current)) followTabIdRef.current = null
    const added = ids.filter((id) => !prev.includes(id))
    // Record openers BEFORE the follow logic: the + commit has already
    // flipped the selection to the new row, so the PREVIOUS render's
    // selection is the opener.
    const prevSelection = prevSelectedRef.current
    for (const id of added) openersRef.current.set(id, prevSelection)
    for (const key of [...openersRef.current.keys()]) {
      if (!ids.includes(key)) openersRef.current.delete(key)
    }
    prevSelectedRef.current = effectiveSelectedId
    if (added.length === 0) return
    const selected = effectiveSelectedId ?? ''
    followTabIdRef.current = added.includes(selected) ? selected : added[added.length - 1]
    requestAnimationFrame(scrollFollowIntoView)
  }, [pages, effectiveSelectedId, scrollFollowIntoView])
  useEffect(() => {
    const scroller = stripScrollRef.current
    const list = scroller?.querySelector('[role="tablist"]')
    if (!scroller || !(list instanceof HTMLElement)) return
    const cancel = () => { followTabIdRef.current = null }
    const ro = new ResizeObserver(() => scrollFollowIntoView())
    ro.observe(list)
    scroller.addEventListener('wheel', cancel)
    scroller.addEventListener('pointerdown', cancel)
    return () => {
      ro.disconnect()
      scroller.removeEventListener('wheel', cancel)
      scroller.removeEventListener('pointerdown', cancel)
    }
  }, [scrollFollowIntoView])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-browser-pane>
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <div ref={stripScrollRef} data-browser-strip-scroll className="min-w-0 flex-1 overflow-x-auto p-1">
          <Tabs
            value={effectiveSelectedId ?? ''}
            onValueChange={setSelectedPageId}
            variant="segment"
            className="w-max"
          >
            <TabsList className="gap-1 bg-muted/60 p-0.5">
              {pages.map((page) => {
                const nav = localNav[page.id]
                const url = displayUrlOf(page, nav)
                // A pending row IS the feedback (the row + its blank surface
                // exist); a separate loading label reads as a waiting state on
                // a page that has, in fact, already appeared.
                const label = nav?.title || page.title || url || 'about:blank'
                const isActive = page.id === effectiveSelectedId
                return (
                  <div key={page.id} className="group/browser-page relative flex items-center" data-browser-tab={page.id}>
                    <LabelTooltip content={url || undefined} wrap>
                      <TabsTrigger
                        value={page.id}
                        indicatorClassName="bg-background shadow-xs ring-1 ring-border"
                        className={cn('h-7 min-h-0 gap-1.5 pl-2.5 pr-7', isActive && 'text-foreground')}
                      >
                        {nav?.favicon ? (
                          <img
                            src={nav.favicon}
                            alt=""
                            aria-hidden="true"
                            className="size-3.5 shrink-0 rounded-detail object-contain"
                          />
                        ) : page.owner !== HUMAN_OWNER ? (
                          <Bot aria-hidden="true" className="size-3.5 shrink-0" />
                        ) : (
                          <Globe aria-hidden="true" className="size-3.5 shrink-0" />
                        )}
                        <MiddleEllipsis name={label} className="max-w-28 text-xs" />
                      </TabsTrigger>
                    </LabelTooltip>
                    <Tooltip content={t('browser.closePage')} wrapperClassName="absolute right-0.5 z-10">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('browser.closePage')}
                        onClick={() => closePage(page.id)}
                        className={cn(
                          'size-5 rounded-md group-hover/browser-page:opacity-100 focus-visible:opacity-100',
                          isActive ? 'opacity-100' : 'opacity-0'
                        )}
                      >
                        <X aria-hidden="true" className="size-3" />
                      </Button>
                    </Tooltip>
                  </div>
                )
              })}
            </TabsList>
          </Tabs>
        </div>
        {!consentRequired ? (
          <Tooltip content={t('browser.newPage')}>
            <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t('browser.newPage')} onClick={newPage}>
              <Plus aria-hidden="true" className="size-4" />
            </Button>
          </Tooltip>
        ) : null}
      </div>
      {status === null ? null : consentRequired ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-card border border-border p-5 text-center" data-browser-consent>
            <p className="text-sm font-medium text-foreground">{t('browser.consentTitle')}</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('browser.consentBody')}</p>
            <Button className="mt-4" onClick={grantConsent}>{t('browser.consentGrant')}</Button>
          </div>
        </div>
      ) : pages.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Globe aria-hidden="true" className="size-6 text-muted-foreground/70" />
          <p className="text-sm text-muted-foreground">{t('browser.emptyHint')}</p>
          <Button variant="outline" size="sm" onClick={newPage}>{t('browser.newPage')}</Button>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          {pages.map((page) => (
            <BrowserPageView
              key={page.id}
              restart={guestRestarts[page.id] ?? 0}
              spawnDelay={restoreSpawnDelaysRef.current.get(page.id)}
              page={page}
              selected={page.id === effectiveSelectedId}
              displayUrl={displayUrlOf(page, localNav[page.id])}
              onNavChange={handleNavChange}
              onWebContentsId={registerWebContentsId}
              bindPageActions={bindPageActions}
              // T16: the annotate mode's Esc gate and its inactive exit read
              // this — same keep-alive rule as the pane's own shortcuts.
              active={active}
              // T14 download indicator: pane-store driven, so it stays put
              // across page switches (the newest entry of the ring).
              download={state.downloads.length > 0 ? state.downloads[state.downloads.length - 1] : null}
            />
          ))}
        </div>
      )}
    </div>
  )
}
