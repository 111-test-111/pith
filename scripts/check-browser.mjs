#!/usr/bin/env node
// 内嵌浏览器移植的纯逻辑检查（无 Electron）。用法：node scripts/check-browser.mjs
// （node ≥ 22.6 需 `node --experimental-strip-types` 跑 .ts import；≥ 23.6 直接跑。）
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BROWSER_MARKER_PREFIX, buildMarkerUrl, parseMarkerUrl,
  normalizeNavigationUrl, isAllowedNavigationUrl, agentOwner, HUMAN_OWNER,
} from '../src/shared/browser.ts'
// ---- Task 2：注册表与工具纯逻辑（pages.ts / tools-core.ts）----
import { createBrowserPageId as sharedPageId } from '../src/shared/browser.ts'
import {
  activePageForOwner, addPage, bumpInteraction, clearAllPages, createBrowserPageId,
  EMPTY_BROWSER_PAGES, pageById, recordSnapshot, removePage, setActivePage,
  setAgentBusy, setCrashed, setPageWebContentsId, setPendingNavigate, updatePageNav,
} from '../src/main/browser/pages.ts'
import {
  BROWSER_TOOL_NAMES, capSnapshotText, diffSnapshotLines, isAiRef,
  parseSnapshotRefs, SNAPSHOT_DEFAULT_MAX_CHARS, SNAPSHOT_MAX_CHARS_LIMIT,
  UNTRUSTED_CONTENT_BEGIN, UNTRUSTED_CONTENT_END, wrapUntrustedContent,
} from '../src/main/browser/tools-core.ts'
// ---- Task 3：service（BrowserService + mock 级套件）----
import {
  BrowserService, BrowserHostUnavailableError, ConsentRequiredError, InvalidRefError,
  NavigationBlockedError, PageGoneError, PageNotFoundError, SnapshotScopeError,
  StaleSnapshotError, __setBrowserServiceForTests, getBrowserService, initBrowserService,
} from '../src/main/browser/service.ts'
// ---- Task 10：agent 工具注册（错误映射 + 参数互斥预检，纯函数）----
import {
  APP_BROWSER_TOOL_NAMES, browserToolErrorText, createBrowserTools, validateNavigateParams,
} from '../src/main/browser/tools.ts'
// ---- Task 4：CDP 端口与接线纯函数 ----
import { getCdpPort, pickCdpPort } from '../src/main/browser/cdp-port.ts'
import { classifyGuestPopup, decideBrowserPermission } from '../src/main/browser/wiring.ts'
// ---- Task 6：渲染层纯逻辑（store/session/zoom/device/open-link/popup）----
import {
  BROWSER_RECENTS_LIMIT, BROWSER_HISTORY_LIMIT, OPEN_BROWSER_PAGES_LIMIT,
  clearBrowserHistory, getBrowserHistory, getRecentUrls, isRecordableUrl,
  pushBrowserHistory, readOpenBrowserPages, recordBrowserHistory, recordRecentUrl,
  snapshotOpenPages, subscribeBrowserRecents, updateBrowserHistoryFavicon,
  updateBrowserHistoryTitle, updateBrowserHistoryTitleFor, upsertRecentUrl, writeOpenBrowserPages,
} from '../src/renderer/src/lib/browser/session.ts'
import {
  BROWSER_ZOOM_STEPS, effectiveWebviewZoom, getBrowserZoom, guestBoxToHost,
  hostPointToGuest, nextBrowserZoom, normalizeBrowserZoom, setBrowserZoom,
  subscribeBrowserZoom,
} from '../src/renderer/src/lib/browser/zoom.ts'
import {
  clampDeviceSize, CUSTOM_DEVICE_ID, DEVICE_PRESETS, DEVICE_SIZE_MAX,
  DEVICE_SIZE_MIN, findDevicePreset,
} from '../src/renderer/src/lib/browser/device.ts'
import {
  BROWSER_OPEN_LINK_EVENT, drainPendingBrowserOpenLinks, getOpenLinksInBrowserPref,
  requestBrowserOpenLink, setOpenLinksInBrowser,
} from '../src/renderer/src/lib/browser/open-link.ts'
import { BROWSER_DOWNLOADS_LIMIT, BrowserStore } from '../src/renderer/src/lib/browser/store.ts'
import { subscribeBrowserPopups } from '../src/renderer/src/lib/browser/popup.ts'

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ---- marker ----
test('marker round-trip incl. agent owner with colon', () => {
  const url = buildMarkerUrl(agentOwner('s1'), 'p-abc12345')
  assert.equal(url, `${BROWSER_MARKER_PREFIX}agent:s1/p-abc12345`)
  assert.deepEqual(parseMarkerUrl(url), { owner: 'agent:s1', pageId: 'p-abc12345' })
  assert.equal(parseMarkerUrl('about:blank'), null)
  assert.equal(parseMarkerUrl(`${BROWSER_MARKER_PREFIX}nolashere`), null)
})

// ---- policy（用例取自 $PIWEB/lib/browser-policy.test.mjs 语义）----
test('normalizeNavigationUrl', () => {
  assert.equal(normalizeNavigationUrl('example.com'), 'https://example.com/')
  assert.equal(normalizeNavigationUrl('localhost:3000/x'), 'http://localhost:3000/x')
  assert.equal(normalizeNavigationUrl('  https://a.b/c '), 'https://a.b/c')
  assert.equal(normalizeNavigationUrl('about:blank'), 'about:blank')
  assert.equal(normalizeNavigationUrl(''), null)
  assert.equal(normalizeNavigationUrl('::::'), null)
})
test('isAllowedNavigationUrl', () => {
  assert.equal(isAllowedNavigationUrl('http://a/'), true)
  assert.equal(isAllowedNavigationUrl('https://a/#frag'), true)
  assert.equal(isAllowedNavigationUrl('about:blank'), true)
  assert.equal(isAllowedNavigationUrl(`${BROWSER_MARKER_PREFIX}human/p-1`), true)
  assert.equal(isAllowedNavigationUrl('file:///etc'), false)
  assert.equal(isAllowedNavigationUrl('javascript:alert(1)'), false)
})

// ---- 常量与 owner 辅助 ----
test('constants and owners', () => {
  assert.equal(BROWSER_MARKER_PREFIX, 'about:blank#pith/')
  assert.equal(HUMAN_OWNER, 'human')
  assert.equal(agentOwner('abc'), 'agent:abc')
})

// ---- pages registry（用例取自 $PIWEB/lib/browser-pages.test.mjs 语义）----
test('addPage appends and auto-activates for the owner; duplicate id is a no-op', () => {
  let s = EMPTY_BROWSER_PAGES
  s = addPage(s, { id: 'p-1', owner: 'human' })
  s = addPage(s, { id: 'p-2', owner: agentOwner('s1') })
  assert.equal(activePageForOwner(s, 'human')?.id, 'p-1')
  assert.equal(activePageForOwner(s, agentOwner('s1'))?.id, 'p-2')
  // 同 owner 再加一页 → active 切换；另一 owner 不受影响
  s = addPage(s, { id: 'p-3', owner: 'human' })
  assert.equal(activePageForOwner(s, 'human')?.id, 'p-3')
  assert.equal(activePageForOwner(s, agentOwner('s1'))?.id, 'p-2')
  assert.equal(addPage(s, { id: 'p-3', owner: 'human' }), s)
  const rec = pageById(s, 'p-3')
  assert.equal(rec.url, 'about:blank')
  assert.equal(rec.title, '')
  assert.equal(rec.agentBusy, false)
  assert.equal(rec.crashed, false)
  assert.equal(rec.interactionGeneration, 0)
  assert.equal(rec.snapshot, null)
})

test('removePage falls back to the owner\u2019s latest remaining page, then drops the key', () => {
  let s = EMPTY_BROWSER_PAGES
  s = addPage(s, { id: 'p-1', owner: agentOwner('s1') })
  s = addPage(s, { id: 'p-2', owner: agentOwner('s1') })
  s = addPage(s, { id: 'p-9', owner: 'human' })
  s = removePage(s, 'p-2') // 删 agent 的 active
  assert.equal(activePageForOwner(s, agentOwner('s1'))?.id, 'p-1')
  assert.equal(activePageForOwner(s, 'human')?.id, 'p-9')
  s = removePage(s, 'p-1')
  assert.equal(activePageForOwner(s, agentOwner('s1')), null)
  assert.equal('agent:s1' in s.activeByOwner, false)
  assert.equal(removePage(s, 'nope'), s)
})

test('setActivePage clears both sides\u2019 snapshots; same id or wrong owner is a no-op', () => {
  let s = EMPTY_BROWSER_PAGES
  s = addPage(s, { id: 'p-1', owner: agentOwner('s1') })
  s = addPage(s, { id: 'p-2', owner: agentOwner('s1') })
  s = recordSnapshot(s, 'p-1', ['e1'])
  s = recordSnapshot(s, 'p-2', ['e2'])
  const switched = setActivePage(s, agentOwner('s1'), 'p-1')
  // 双方 snapshot 无条件清空
  assert.equal(pageById(switched, 'p-1')?.snapshot, null)
  assert.equal(pageById(switched, 'p-2')?.snapshot, null)
  assert.equal(activePageForOwner(switched, agentOwner('s1'))?.id, 'p-1')
  assert.equal(setActivePage(s, agentOwner('s1'), 'p-2'), s)
  assert.equal(setActivePage(s, 'human', 'p-1'), s)
})

test('updatePageNav clears the snapshot only when the url changes; title follows', () => {
  let s = EMPTY_BROWSER_PAGES
  s = addPage(s, { id: 'p-1', owner: 'human', url: 'about:blank' })
  s = recordSnapshot(s, 'p-1', ['e1'])
  const moved = updatePageNav(s, 'p-1', 'https://a.dev/', 'A')
  const rec = pageById(moved, 'p-1')
  assert.equal(rec.url, 'https://a.dev/')
  assert.equal(rec.title, 'A')
  assert.equal(rec.snapshot, null)
  // url 未变 → snapshot 保留（同页 title 更新）
  const withSnap = recordSnapshot(moved, 'p-1', ['e9'])
  const sameUrl = updatePageNav(withSnap, 'p-1', 'https://a.dev/', 'A2')
  assert.equal(pageById(sameUrl, 'p-1').snapshot, pageById(withSnap, 'p-1').snapshot)
  assert.equal(pageById(sameUrl, 'p-1').title, 'A2')
})

test('bumpInteraction increments the generation that recordSnapshot captures', () => {
  let s = EMPTY_BROWSER_PAGES
  s = addPage(s, { id: 'p-1', owner: agentOwner('s1') })
  s = bumpInteraction(s, 'p-1')
  s = recordSnapshot(s, 'p-1', ['e3'])
  assert.deepEqual(pageById(s, 'p-1').snapshot, { refs: ['e3'], interactionGeneration: 1 })
  s = bumpInteraction(s, 'p-1')
  assert.equal(pageById(s, 'p-1').interactionGeneration, 2)
  // 旧快照停在记录时的代数——这是活跃性校验的依据
  assert.equal(pageById(s, 'p-1').snapshot.interactionGeneration, 1)
})

test('setPendingNavigate records the url; null deletes the key', () => {
  let s = EMPTY_BROWSER_PAGES
  s = addPage(s, { id: 'p-1', owner: agentOwner('s1') })
  s = setPendingNavigate(s, 'p-1', 'https://example.com/')
  assert.equal(pageById(s, 'p-1').pendingNavigate, 'https://example.com/')
  s = setPendingNavigate(s, 'p-1', null)
  assert.equal(pageById(s, 'p-1').pendingNavigate, undefined)
  assert.equal('pendingNavigate' in pageById(s, 'p-1'), false)
  // 再次 null：页记录原样（状态不变）；未知 id：整个状态原样
  const before = pageById(s, 'p-1')
  const again = setPendingNavigate(s, 'p-1', null)
  assert.equal(pageById(again, 'p-1'), before)
  assert.equal(setPendingNavigate(s, 'nope', 'https://x/'), s)
})

test('setCrashed flags and clears the snapshot; setAgentBusy round-trips', () => {
  let s = EMPTY_BROWSER_PAGES
  s = addPage(s, { id: 'p-1', owner: agentOwner('s1') })
  s = recordSnapshot(s, 'p-1', ['e1'])
  s = setAgentBusy(s, 'p-1', true)
  assert.equal(pageById(s, 'p-1').agentBusy, true)
  s = setAgentBusy(s, 'p-1', false)
  s = setCrashed(s, 'p-1')
  assert.equal(pageById(s, 'p-1').crashed, true)
  assert.equal(pageById(s, 'p-1').snapshot, null)
})

test('setPageWebContentsId records the guest id; same value is a no-op', () => {
  let s = EMPTY_BROWSER_PAGES
  s = addPage(s, { id: 'p-1', owner: 'human' })
  s = setPageWebContentsId(s, 'p-1', 42)
  assert.equal(pageById(s, 'p-1').webContentsId, 42)
  // 同值重复上报：页记录原样（状态不变）；未知 id：整个状态原样
  const rec = pageById(s, 'p-1')
  const again = setPageWebContentsId(s, 'p-1', 42)
  assert.equal(pageById(again, 'p-1'), rec)
  assert.equal(setPageWebContentsId(s, 'nope', 7), s)
})

test('clearAllPages resets; createBrowserPageId is the shared re-export', () => {
  const s = addPage(EMPTY_BROWSER_PAGES, { id: 'p-1', owner: 'human' })
  assert.equal(clearAllPages(), EMPTY_BROWSER_PAGES)
  assert.equal(clearAllPages().pages.length, 0)
  // 单一实现：pages 只 re-export，不自定义
  assert.equal(createBrowserPageId, sharedPageId)
  assert.ok(createBrowserPageId().startsWith('p-'))
})

// ---- tools-core（用例取自 $PIWEB/lib/browser-tools.test.mjs 语义）----
test('BROWSER_TOOL_NAMES is the verbatim 13-tool list', () => {
  assert.deepEqual([...BROWSER_TOOL_NAMES], [
    'browser_navigate', 'browser_pages', 'browser_focus', 'browser_snapshot',
    'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll',
    'browser_wait_for', 'browser_screenshot', 'browser_close', 'browser_hover',
    'browser_select',
  ])
  assert.ok(BROWSER_TOOL_NAMES.every((n) => n.startsWith('browser_')))
})

test('parseSnapshotRefs extracts every ref, incl. iframe fNeM form, deduped', () => {
  assert.deepEqual([...parseSnapshotRefs('button [ref=e5] … [ref=f1e46]')].sort(), ['e5', 'f1e46'])
  assert.deepEqual(
    [...parseSnapshotRefs('- button "OK" [ref=e2]\n- link "a" [ref=e2]\n- textbox "x" [ref=f12e3]')].sort(),
    ['e2', 'f12e3'],
  )
  assert.equal(parseSnapshotRefs('no refs').size, 0)
})

test('isAiRef accepts only eN / fNeM shapes', () => {
  for (const ok of ['e5', 'e123', 'f1e46', 'f12e3']) assert.equal(isAiRef(ok), true, ok)
  for (const bad of ['e5x', 'e', '1e', 'f1e', 'fe1', 'f1e2e3', 'e1; rm -rf /', 3, null, undefined]) {
    assert.equal(isAiRef(bad), false, String(bad))
  }
})

test('capSnapshotText: short verbatim, over cap truncated with note, caps clamp', () => {
  assert.equal(SNAPSHOT_DEFAULT_MAX_CHARS, 20_000)
  assert.equal(SNAPSHOT_MAX_CHARS_LIMIT, 200_000)
  assert.equal(capSnapshotText('short'), 'short')
  const capped = capSnapshotText('x'.repeat(5000), 100)
  assert.ok(capped.startsWith('x'.repeat(100)))
  assert.match(capped, /快照已截断：共 5000 字符，仅显示前 100/)
  // 非法上限被夹取为 0 → 全部截掉，不抛错
  assert.equal(capSnapshotText('abc', -5).includes('abc'), false)
})

test('wrapUntrustedContent fences the text between the boundary markers', () => {
  const wrapped = wrapUntrustedContent('page text')
  assert.equal(wrapped, `${UNTRUSTED_CONTENT_BEGIN}\npage text\n${UNTRUSTED_CONTENT_END}`)
  assert.ok(wrapped.startsWith(UNTRUSTED_CONTENT_BEGIN))
  assert.ok(wrapped.endsWith(UNTRUSTED_CONTENT_END))
})

test('diffSnapshotLines: identical sentinel, +/- prefixes, folding, oversized fallback', () => {
  // 完全相同
  assert.equal(diffSnapshotLines('a\nb\nc', 'a\nb\nc'), '(快照无变化)')
  // 增删行前缀正确，未变行折叠为计数
  const d = diffSnapshotLines('a\nb\nc', 'a\nx\nc\nd')
  assert.ok(d.includes('- b'))
  assert.ok(d.includes('+ x'))
  assert.ok(d.includes('+ d'))
  assert.ok(!d.includes('- a'))
  assert.ok(d.includes('1 行未变化'))
  // 长未变段合并为一条计数
  const old10 = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
  const new10 = `l0\nNEW\n${Array.from({ length: 9 }, (_, i) => `l${i + 1}`).join('\n')}`
  const d2 = diffSnapshotLines(old10, new10)
  assert.ok(d2.includes('+ NEW'))
  assert.ok(d2.includes('1 行未变化'))
  assert.ok(d2.includes('9 行未变化'))
  // 行数乘积超 4_000_000 → 不建矩阵，直接回退新快照全文
  const big = Array.from({ length: 3000 }, (_, i) => `o${i}`).join('\n')
  const bigNew = Array.from({ length: 3000 }, (_, i) => `n${i}`).join('\n')
  assert.equal(diffSnapshotLines(big, bigNew), bigNew)
})

// ---- Task 3：BrowserService mock 套件（移植自 $PIWEB/lib/browser-service.test.mjs 的结构性 mock）----

// renderer 角色模拟：pendingCreate 出现即物化为带 marker 的 guest（webview 的 mock 等价物）——
// reconcile 登记后服务端的建页 waiter 放行。返回 stop 函数；unref：泄漏到测试结束也不挡进程退出。
function autoMaterialize(svc, ctx) {
  const timer = setInterval(() => {
    const pending = svc.getStatus().pendingCreates
    if (pending.length === 0) return
    for (const p of pending) {
      // Object.create(defaultPageOpts)：建页后的迟滞变异（snapshotText/annotatedB64 等）经原型链可见
      ctx.pages.push(mockPage(Object.assign(Object.create(ctx.defaultPageOpts ?? {}), { url: buildMarkerUrl(p.owner, p.id) })))
    }
    void svc.reconcileElectronTargets()
  }, 5)
  timer.unref()
  return () => clearInterval(timer)
}

// ---- playwright 结构 mock ----
function mockCdp(log) {
  const handlers = new Map()
  const cdp = {
    handlers,
    sent: log,
    calls: [],
    pageEnabled: false,
    // 按方法名定制应答（resolveElementAt 等测试用）
    replies: new Map(),
    on: (ev, cb) => handlers.set(ev, cb),
    send: async (method, params) => {
      log.push(method)
      cdp.calls.push({ method, params })
      if (cdp.replies.has(method)) return cdp.replies.get(method)(params)
      if (method === 'Page.enable') cdp.pageEnabled = true
      return {}
    },
    detach: async () => {},
    emit: (ev, params) => handlers.get(ev)?.(params),
  }
  return cdp
}
function mockPage(opts = {}) {
  const listeners = new Map()
  const page = {
    _url: opts.url ?? 'about:blank',
    _closed: false,
    _opener: opts.opener ?? null,
    on: (ev, cb) => listeners.set(ev, cb),
    emit: (ev) => listeners.get(ev)?.(),
    url: () => page._url,
    title: async () => page._title ?? 'T',
    goto: async (u) => { page._url = u },
    goBack: async (options) => { (opts.actionLog ??= []).push(`goBack${options?.timeout ? `:${options.timeout}` : ''}`) },
    goForward: async (options) => { (opts.actionLog ??= []).push(`goForward${options?.timeout ? `:${options.timeout}` : ''}`) },
    reload: async () => { (opts.actionLog ??= []).push('reload') },
    close: async () => { page._closed = true; page.emit('close') },
    isClosed: () => page._closed,
    opener: async () => page._opener,
    ariaSnapshot: async () => opts.snapshotText ?? '- button "OK" [ref=e1]\n- textbox "q" [ref=e2]',
    // 页面上下文求值：按 service 内 evaluate 脚本的可识别片段分派
    evaluate: async (fn, arg) => {
      const f = String(fn)
      // settleForSnapshot 的 DOM 采样（infra 调用，不入 actionLog；计数可脚本化）
      if (f.includes('MutationObserver')) {
        if (opts.mutateUrlOnSample) { page._url = opts.mutateUrlOnSample; opts.mutateUrlOnSample = undefined }
        return (opts.mutationScript ?? []).length > 0 ? opts.mutationScript.shift() : (opts.mutationCount ?? 0)
      }
      // annotate 的离屏 canvas 合成（真实页返回 base64；mock 返回 annotatedB64）
      if (f.includes('toDataURL')) {
        (opts.actionLog ??= []).push('evaluate')
        return opts.annotatedB64 ?? null
      }
      (opts.actionLog ??= []).push('evaluate')
      // agentScroll 的视口尺寸查询（window.innerWidth/innerHeight）
      if (f.includes('innerWidth')) return [800, 600]
      // agentScroll 的滚动校验（window.scrollX/scrollY）：wheel 命中由 mockCdp 联动推进
      if (f.includes('scrollY')) return [0, opts._scrollY ?? 0]
      // agentScroll 的 wheel 失效兜底（window.scrollBy）
      if (f.includes('scrollBy')) { (opts.actionLog ??= []).push(`scrollBy:${JSON.stringify(arg)}`); return 0 }
      // resolveElementAt（document.elementFromPoint）：结果由测试经 elementAtInfo 控制
      if (f.includes('elementFromPoint')) {
        (opts.actionLog ??= []).push(`elementAt:${JSON.stringify(arg)}`)
        return opts.elementAtInfo === undefined ? null : opts.elementAtInfo
      }
      return opts.evaluateReturn ?? 0
    },
    locator: (sel) => ({
      // 注意：结构上没有 fill 方法——service 的 agentTypeRef 若走 fill 会直接 TypeError
      click: async () => { (opts.actionLog ??= []).push(`click:${sel}`) },
      pressSequentially: async (text, options) => { (opts.actionLog ??= []).push(`type:${sel}:${text}`); (opts.typeOpts ??= {}).timeout = options?.timeout },
      press: async () => {},
      hover: async () => { (opts.actionLog ??= []).push(`hover:${sel}`) },
      selectOption: async (values) => { (opts.actionLog ??= []).push(`select:${sel}:${values.join(',')}`) },
      scrollIntoViewIfNeeded: async (options) => { (opts.actionLog ??= []).push(`scrollIntoView:${sel}`); (opts.scrollOpts ??= {}).timeout = options?.timeout },
      boundingBox: async () => {
        (opts.actionLog ??= []).push(`boundingBox:${sel}`)
        return opts.boundingBox === null ? null : (opts.boundingBox ?? { x: 1, y: 2, width: 30, height: 10 })
      },
      ariaSnapshot: async () => {
        if (opts.scopedSnapshotError) throw new Error('strict mode violation: 2 elements')
        return opts.scopedSnapshot ?? '- link "scoped" [ref=e7]'
      },
      first: function () { return this },
      waitFor: async () => { if (opts.selectorWaitFail === true) throw new Error('Timeout 5000ms exceeded') },
    }),
    getByText: (text) => ({ first: () => ({ waitFor: async () => { if (opts.textWaitFail === text) throw new Error('Timeout 5000ms exceeded') } }) }),
    keyboard: { press: async (key) => { (opts.actionLog ??= []).push(`key:${key}`) } },
    mouse: { wheel: async (dx, dy) => { (opts.actionLog ??= []).push(`wheel:${dx},${dy}`) } },
    screenshot: async () => {
      // shotFail 用共享对象（原型链可见）：测试中途重设 pageOpts.shotFail 也能生效
      if ((opts.shotFail?.n ?? 0) > 0) { opts.shotFail.n -= 1; throw new Error('Timeout 5000ms exceeded') }
      return Buffer.from('jpeg')
    },
    waitForTimeout: async () => {},
    waitForLoadState: async (state) => { (opts.actionLog ??= []).push(`loadState:${state}`) },
  }
  return page
}
function mockContext(pages = [], pageOpts = {}) {
  const listeners = new Map()
  const ctx = {
    defaultPageOpts: pageOpts,
    // 壳窗口 page 恒在（reconcile 的排除项；pi-app dev 由 vite 加载 5173）；
    // 需要「无壳窗口」场景的测试先清掉。
    pages: [mockPage({ url: 'http://localhost:5173/' }), ...pages],
    cdps: [],
    on: (ev, cb) => listeners.set(ev, cb),
    emit: (ev, ...a) => listeners.get(ev)?.(...a),
    newPage: async () => {
      const p = mockPage(pageOpts)
      ctx.pages.push(p)
      listeners.get('page')?.(p)
      return p
    },
    newCDPSession: async (page) => {
      const c = mockCdp([])
      c.page = page
      ctx.cdps.push(c)
      mockContext.last = c
      // wheel 命中联动滚动位置（agentScroll 的校验读它）；wheelBroken 时静止，触发兜底断言
      const send = c.send
      c.send = async (method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseWheel' && !pageOpts.wheelBroken) {
          pageOpts._scrollY = (pageOpts._scrollY ?? 0) + (params.deltaY ?? 0)
        }
        return send(method, params)
      }
      return c
    },
    close: async () => {},
  }
  return ctx
}
// service 只认注入的 deps：内存 consent、显式 cdpPort、注入连接函数、零成本落定 settle。
function makeDeps(ctx, extra = {}) {
  let granted = false
  return {
    cdpPort: 19222,
    consent: {
      get: () => granted,
      grant: () => { granted = true },
    },
    connectElectronFn: async () => ({ contexts: () => [ctx], on: () => {}, close: async () => {} }),
    // 单测默认零成本落定（settle 逻辑由专项测试用自己的计时验证）
    settle: { warmupMs: 0, sampleMs: 0, budgetMs: 0 },
    ...extra,
  }
}
async function consentedService(pageOpts = {}, depsExtra = {}) {
  const ctx = mockContext([], pageOpts)
  const svc = new BrowserService(makeDeps(ctx, depsExtra))
  svc.grantConsent()
  svc.__stopAuto = autoMaterialize(svc, ctx)
  svc.__ctx = ctx // 测试断言用（CDP 调用日志在 ctx.cdps）
  return svc
}

// 1. consent 前拒绝 → grant 后可建
test('service: 未 consent 时 createPage/agentNavigate 抛 ConsentRequiredError；grant 后可建页', async () => {
  const ctx = mockContext()
  const svc = new BrowserService(makeDeps(ctx))
  await assert.rejects(svc.createPage('human'), ConsentRequiredError)
  await assert.rejects(svc.agentNavigate('agent:s1', 'https://a.dev'), ConsentRequiredError)
  svc.grantConsent()
  const stop = autoMaterialize(svc, ctx)
  const meta = await svc.createPage('human', 'https://a.dev')
  assert.equal(meta.owner, 'human')
  assert.equal(svc.listPages().length, 1)
  stop()
})

// 2. 建页握手（createPage resolve 且注册表含 marker id）
test('service: 建页握手——pendingCreate 暴露给 renderer，marker target 登记后放行并导航', async () => {
  const ctx = mockContext()
  const svc = new BrowserService(makeDeps(ctx)) // 不 arm autoMaterialize：手动控制时序
  svc.grantConsent()
  const promise = svc.createPage('agent:s1', 'https://a.dev/')
  await new Promise((r) => setTimeout(r, 20)) // ensureStarted 落定后 pendingCreate 入队
  const pending = svc.getStatus().pendingCreates
  assert.equal(pending.length, 1)
  const { id, owner } = pending[0]
  assert.equal(owner, 'agent:s1')
  // renderer 物化：guest 带 marker URL 浮现 → reconcile 登记 runtime → waiter 放行
  const guest = mockPage({ url: buildMarkerUrl(owner, id) })
  ctx.pages.push(guest)
  await svc.reconcileElectronTargets()
  const meta = await promise
  assert.equal(meta.id, id)
  assert.ok(svc.listPages().some((p) => p.id === id), '注册表含 marker 的 pageId')
  assert.equal(guest._url, 'https://a.dev/', 'createPage 的 url 在登记后由服务端 goto')
  assert.equal(svc.getStatus().pendingCreates.length, 0)
})

// 3. 握手超时（生产 15s；测试注入 30ms）→ BrowserHostUnavailableError
test('service: 建页握手超时（默认 15s；测试注入 createTimeoutMs:30）抛 BrowserHostUnavailableError 并清出队列', async () => {
  const ctx = mockContext()
  const svc = new BrowserService(makeDeps(ctx, { createTimeoutMs: 30 }))
  svc.grantConsent()
  await assert.rejects(svc.createPage('agent:s1'), BrowserHostUnavailableError)
  assert.equal(svc.getStatus().pendingCreates.length, 0)
})

// 4. closePage 后 reconcile 不重登（closingTargetIds 宽限，手做两轮 reconcile）
test('service: closePage 摘除后 target 尚存的两轮 reconcile 不重登（closingTargetIds 宽限）', async () => {
  const ctx = mockContext()
  const svc = new BrowserService(makeDeps(ctx))
  svc.grantConsent()
  const stop = autoMaterialize(svc, ctx)
  const meta = await svc.createPage('human')
  const guest = ctx.pages.find((p) => parseMarkerUrl(p._url) !== null)
  assert.ok(guest, 'marker target 应已浮现')
  await svc.closePage(meta.id)
  assert.equal(svc.listPages().length, 0)
  assert.equal(guest.isClosed(), false, 'guest 的销毁是 renderer 卸载 webview 的职责，服务端不调 page.close')
  // 复刻 renderer 卸载前的在途窗口：mock page 仍在 ctx.pages 且带 marker URL——
  // 手做两轮 reconcile（≈ 宽限期的两个轮询周期），不得按 marker 重登
  assert.ok(ctx.pages.includes(guest))
  await svc.reconcileElectronTargets()
  await svc.reconcileElectronTargets()
  assert.equal(svc.listPages().length, 0, 'close 在途的 target 不得被重登')
  stop()
})

// 5. bumpInteractionByWebContentsId 使 ref 失效
test('service: bumpInteractionByWebContentsId 使旧 snapshot 的 ref 失效（StaleSnapshotError）', async () => {
  const ctx = mockContext()
  const svc = new BrowserService(makeDeps(ctx))
  svc.grantConsent()
  ctx.pages.push(mockPage({ url: buildMarkerUrl('agent:s1', 'p-wc1') }))
  await svc.reconcileElectronTargets()
  svc.registerExternalPage({ id: 'p-wc1', owner: 'agent:s1', url: 'https://a.dev/', webContentsId: 77 })
  await svc.agentSnapshot('agent:s1') // 记录 ref e1/e2
  // 人在 agent 页上操作（主进程 input-event 中继的语义等价物）→ 旧 snapshot 失效
  svc.bumpInteractionByWebContentsId(77)
  await assert.rejects(svc.agentClickRef('agent:s1', 'e1'), StaleSnapshotError)
  // 未知 wcId 不影响
  await svc.agentSnapshot('agent:s1')
  svc.bumpInteractionByWebContentsId(999)
  await svc.agentClickRef('agent:s1', 'e1')
})

// 6. agentTypeRef 走 click+ControlOrMeta+A+pressSequentially，断言无 fill
test('service: agentTypeRef 走 click→ControlOrMeta+A→pressSequentially 键盘链（禁 fill），submit 补 Enter', async () => {
  const pageOpts = { actionLog: [] }
  const svc = await consentedService(pageOpts)
  await svc.agentNavigate('agent:s1', 'https://a.dev')
  await svc.agentTypeRef('agent:s1', 'e2', 'hello', true)
  // fill 的 Input.insertText 在非可见 webview guest 上静默无效（spike 实测）——必须走键盘链；
  // mockPage 的 locator 结构上就没有 fill 方法，任何 fill 调用都会直接 TypeError
  assert.deepEqual(pageOpts.actionLog, [
    'click:aria-ref=e2', 'key:ControlOrMeta+A', 'type:aria-ref=e2:hello', 'key:Enter',
  ])
  assert.ok(!pageOpts.actionLog.some((entry) => entry.includes('fill')), '不得出现 fill')
  // 空文本 = 纯清空
  pageOpts.actionLog.length = 0
  await svc.agentTypeRef('agent:s1', 'e2', '')
  assert.deepEqual(pageOpts.actionLog, ['click:aria-ref=e2', 'key:ControlOrMeta+A'])
})

// 7. 非法 scheme → NavigationBlockedError
test('service: agentNavigate 的 scheme 白名单外 URL 抛 NavigationBlockedError 且不留页', async () => {
  const svc = await consentedService()
  await assert.rejects(svc.agentNavigate('agent:s1', 'file:///etc/passwd'), NavigationBlockedError)
  await assert.rejects(svc.agentNavigate('agent:s1', 'javascript:alert(1)'), NavigationBlockedError)
  assert.equal(svc.listPages().length, 0, '被拦的导航不产生任何页')
})

// 8. popup opener 归属继承（context.on('page') 触发带 opener 的 mock）
test('service: popup 继承 opener 的 owner；agent 动作经 newPages 拿到', async () => {
  const svc = await consentedService()
  const r1 = await svc.agentNavigate('agent:s1', 'https://a.dev')
  assert.ok(r1.snapshot.includes('[ref=e1]'))
  // 模拟该 agent 页弹出 _blank 新页（带真实 URL——空白 popup 会被留给 reconcile 的 marker 路径）
  const opener = svc.__ctx.pages.find((p) => p._url === 'https://a.dev')
  const popup = mockPage({ opener, url: 'https://pop.dev/' })
  svc.__ctx.pages.push(popup) // 真实浮现的 target 一定在 pages() 里——否则 reconcile 消失清扫会立刻注销它
  svc.__ctx.emit('page', popup)
  await new Promise((r) => setTimeout(r, 10)) // registerPopup 的宏任务去重延迟
  assert.equal(svc.agentPages('agent:s1').pages.length, 2)
  const r2 = await svc.agentSnapshot('agent:s1')
  assert.equal(r2.newPages.length, 1)
  assert.equal(r2.newPages[0].owner, 'agent:s1')
})

// 9. 断线 → 注册表清空、再建页自动重连
test('service: browser disconnected 后注册表清空，再建页自动重连', async () => {
  const ctx = mockContext()
  let connected = 0
  const browser = {
    contexts: () => [ctx],
    on: (ev, cb) => { browser.emitDisconnected = cb },
    close: async () => { browser.closeCalled = true },
  }
  const svc = new BrowserService(makeDeps(ctx, {
    connectElectronFn: async () => { connected++; return browser },
  }))
  svc.grantConsent()
  const stop = autoMaterialize(svc, ctx)
  await svc.createPage('human')
  assert.equal(svc.listPages().length, 1)
  browser.emitDisconnected()
  assert.equal(svc.listPages().length, 0, '断线清空注册表')
  assert.equal(svc.getStatus().available, true, 'available 恒 true（渲染层沿用字段）')
  // 断开即视为壳退出：旧 guest 随壳销毁，新连接的 context 不再持有它们
  //（若旧 target 仍存活，reconcile 重登反而是自愈——那是另一种场景）
  ctx.pages.length = 0
  await svc.createPage('human')
  assert.equal(connected, 2, '断线后再建页应重新 connect')
  assert.equal(svc.listPages().length, 1)
  assert.equal(browser.closeCalled, undefined, '断线/重建也绝不调 browser.close()')
  stop()
})

// 10. settle 注入归零后 snapshot 立即返回
test('service: settle 注入归零后动作→快照立即返回（繁忙页面也不进采样循环）', async () => {
  const pageOpts = { mutationCount: 999 } // 页面"永不静默"——预算 0 时也不得采样
  const svc = await consentedService(pageOpts)
  await svc.agentNavigate('agent:s1', 'https://a.dev')
  const t0 = Date.now()
  const r = await svc.agentSnapshot('agent:s1')
  assert.ok(Date.now() - t0 < 100, `settle 预算 0 应立即返回，实际 ${Date.now() - t0}ms`)
  assert.ok(r.snapshot.includes('[ref=e1]'))
})

// 11. onStateChange 在 addPage 后 ≤50ms 被调；30ms 合并窗内多次赋值只回调一次
test('service: onStateChange 在注册表变更后 ≤50ms 被调；合并窗内多次赋值只回调一次', async () => {
  const ctx = mockContext()
  let calls = 0
  const svc = new BrowserService(makeDeps(ctx, { onStateChange: () => { calls++ } }))
  svc.grantConsent()
  ctx.pages.push(mockPage({ url: buildMarkerUrl('human', 'p-ev1') }))
  await svc.reconcileElectronTargets() // addPage 赋值
  assert.equal(svc.listPages().length, 1)
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(calls >= 1, 'addPage 后 50ms 内 onStateChange 应被调')
  // 合并：url 与异步 title 的多次赋值落进同一个 30ms 窗 → 只回调一次
  const before = calls
  ctx.pages.find((p) => parseMarkerUrl(p._url) !== null)._url = 'https://moved.example/'
  await svc.reconcileElectronTargets()
  await svc.reconcileElectronTargets()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(calls, before + 1, '30ms 合并窗内的多次赋值只回调一次')
})

// 12. dispose 不调 browser.close()（mock 上放哨兵）
test('service: dispose 只丢引用——绝不调 browser.close()，未触发的状态通知一并清理', async () => {
  const ctx = mockContext()
  let stateCalls = 0
  const browser = {
    contexts: () => [ctx],
    on: () => {},
    close: async () => { browser.closeCalled = true },
  }
  const svc = new BrowserService(makeDeps(ctx, {
    connectElectronFn: async () => browser,
    onStateChange: () => { stateCalls++ },
  }))
  svc.grantConsent()
  ctx.pages.push(mockPage({ url: buildMarkerUrl('human', 'p-dispose') }))
  await svc.reconcileElectronTargets()
  assert.equal(svc.listPages().length, 1)
  svc.dispose()
  assert.equal(browser.closeCalled, undefined, 'dispose 绝不调 browser.close()')
  assert.equal(svc.listPages().length, 0, 'dispose 清空注册表（只丢引用）')
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(stateCalls, 0, 'dispose 清理未触发的状态通知定时器')
})

// 13. 壳窗口排除（pi-app 判定：http://localhost:* / file://）
test('service: 壳窗口（http://localhost:* / file://）与无 marker target 不进注册表', async () => {
  const ctx = mockContext() // 自带 http://localhost:5173/ 壳窗口
  ctx.pages.push(mockPage({ url: 'file:///Users/x/pi-app/out/main/index.mjs' }))
  ctx.pages.push(mockPage({ url: 'about:blank' }))
  ctx.pages.push(mockPage({ url: buildMarkerUrl('human', 'p-shell1') }))
  const svc = new BrowserService(makeDeps(ctx))
  svc.grantConsent()
  await svc.reconcileElectronTargets()
  const pages = svc.listPages()
  assert.equal(pages.length, 1)
  assert.equal(pages[0].id, 'p-shell1')
  assert.equal(pages[0].owner, 'human')
})

// 14. registerExternalPage：幂等 / 白名单外拒绝 / 关闭后不复活
test('service: registerExternalPage 幂等登记、scheme 白名单外与空 id 拒绝、关闭后不复活', async () => {
  const svc = await consentedService()
  const page = svc.registerExternalPage({ id: 'p-ext', owner: 'human', url: 'https://a.dev/' })
  assert.ok(page, 'state-only 登记返回行')
  assert.equal(page.url, 'https://a.dev/')
  assert.equal(svc.registerExternalPage({ id: 'p-ext', owner: 'human', url: 'https://a.dev/' }), null, '重复上报幂等')
  assert.equal(svc.registerExternalPage({ id: 'p-bad', owner: 'human', url: 'file:///etc/passwd' }), null, 'scheme 白名单外拒绝')
  assert.equal(svc.registerExternalPage({ id: '', owner: 'human', url: 'https://a.dev/' }), null, '空 id 拒绝')
  assert.equal(svc.listPages().length, 1)
  await svc.closePage('p-ext')
  assert.equal(svc.listPages().length, 0)
  assert.equal(svc.registerExternalPage({ id: 'p-ext', owner: 'human', url: 'https://a.dev/' }), null, '已退休 id 不复活')
})

// 15. 超时封顶：type/scrollIntoView/goBack/goForward 8s、goto 20s；reload 不走 page.reload()
test('service: type/scrollIntoView/goBack/goForward 均 8s、goto 20s（封死 Playwright 默认 30s）', async () => {
  const pageOpts = { actionLog: [], typeOpts: {}, scrollOpts: {} } // 共享对象：mock 写入对测试可见
  const svc = await consentedService(pageOpts)
  await svc.agentNavigate('agent:s1', 'https://a.dev')
  await svc.agentTypeRef('agent:s1', 'e2', 'hi')
  await svc.agentScroll('agent:s1', { ref: 'e2' })
  assert.equal(pageOpts.typeOpts?.timeout, 8000, 'pressSequentially 带 8s 交互超时')
  assert.equal(pageOpts.scrollOpts?.timeout, 8000, 'scrollIntoViewIfNeeded 带 8s 交互超时')
  await svc.agentHistory('agent:s1', 'back')
  await svc.agentHistory('agent:s1', 'forward')
  await svc.agentHistory('agent:s1', 'reload')
  assert.ok(pageOpts.actionLog.includes('goBack:8000'), 'goBack 未带 8s 超时')
  assert.ok(pageOpts.actionLog.includes('goForward:8000'), 'goForward 未带 8s 超时')
  assert.ok(!pageOpts.actionLog.includes('reload'), 'reload 不得走 page.reload()（CDP Page.reload 会毁掉 Electron webview）')
  // goto 带 20s 导航超时
  const guest = svc.__ctx.pages.find((p) => p._url === 'https://a.dev')
  const seen = []
  const origGoto = guest.goto
  guest.goto = async (u, o) => { seen.push(o); return origGoto(u, o) }
  await svc.agentNavigate('agent:s1', 'https://b.dev')
  assert.equal(seen.at(-1)?.timeout, 20000, 'goto 未带 20s 导航超时')
})

// 16. 单例：init 幂等 / get / 测试注入
test('service: initBrowserService 幂等；getBrowserService/__setBrowserServiceForTests 注入', () => {
  const a = initBrowserService(makeDeps(mockContext()))
  const b = initBrowserService(makeDeps(mockContext()))
  assert.equal(a, b, '重复 init 返回现有实例')
  assert.equal(getBrowserService(), a)
  const sentinel = { dispose: () => {} }
  __setBrowserServiceForTests(sentinel)
  assert.equal(getBrowserService(), sentinel)
  __setBrowserServiceForTests(null)
  assert.equal(getBrowserService(), null)
})

// ---- Task 4：CDP 端口与接线纯函数 ----
test('decideBrowserPermission: allowlist 三真；media/geolocation/notifications/midi/serial/usb/bluetooth 一律假', () => {
  assert.equal(decideBrowserPermission('fullscreen'), true)
  assert.equal(decideBrowserPermission('clipboard-sanitized-write'), true)
  assert.equal(decideBrowserPermission('pointerLock'), true)
  for (const denied of ['media', 'geolocation', 'notifications', 'midi', 'serial', 'usb', 'bluetooth']) {
    assert.equal(decideBrowserPermission(denied), false, denied)
  }
  // allowlist 之外的合法权限名同样拒绝
  assert.equal(decideBrowserPermission('window-management'), false)
})

test('classifyGuestPopup: marker 前缀 / 壳文档（http://localhost:* 与 file://） / 普通页三分类', () => {
  assert.equal(classifyGuestPopup(buildMarkerUrl(agentOwner('s1'), 'p-pop1')), 'marker')
  assert.equal(classifyGuestPopup('http://localhost:5173/workspace'), 'shell')
  assert.equal(classifyGuestPopup('file:///Users/x/pi-app/out/renderer/index.html'), 'shell')
  assert.equal(classifyGuestPopup('https://example.com/page?q=1'), 'guest')
  assert.equal(classifyGuestPopup('about:blank'), 'guest', '空白 popup 留给 renderer 建页流程')
})

test('pickCdpPort: PITH_CDP_PORT 合法优先；非法/缺省回落 19000–38999；getCdpPort 记录同值', () => {
  const original = process.env.PITH_CDP_PORT
  try {
    process.env.PITH_CDP_PORT = '34567'
    assert.equal(pickCdpPort(), 34567)
    assert.equal(getCdpPort(), 34567)
    for (const invalid of ['0', '65536', '-1', 'abc', '19000.5', '']) {
      process.env.PITH_CDP_PORT = invalid
      const port = pickCdpPort()
      assert.ok(Number.isInteger(port) && port >= 19000 && port <= 38999, `非法 env ${JSON.stringify(invalid)} 应回落区间，实际 ${port}`)
    }
    delete process.env.PITH_CDP_PORT
    const port = pickCdpPort()
    assert.ok(port >= 19000 && port <= 38999, `无 env 应回落区间，实际 ${port}`)
    assert.equal(getCdpPort(), port)
  } finally {
    if (original === undefined) delete process.env.PITH_CDP_PORT
    else process.env.PITH_CDP_PORT = original
  }
})

// ---- Task 6：渲染层纯逻辑（node 直测；window/localStorage 桩仅在下列用例内安装并还原，
// 前面的 service 套件不可见桩）----
// Map 桩 + setItem 写入日志 + CustomEvent 收集：withWindowShim(fn) 在 fn 期间替换
// globalThis.window，结束（含抛错）后原样还原。渲染层模块全部惰性访问 window——
// 模块导入不触窗，首次 get*/record* 调用发生在桩内。
function withWindowShim(fn) {
  const store = new Map()
  const writes = []
  const events = []
  const previous = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { writes.push([k, String(v)]); store.set(k, String(v)) },
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    },
    dispatchEvent: (e) => { events.push(e) },
  }
  try {
    return fn({ store, writes, events })
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
}

// ---- zoom：阶梯吸附/夹取/相对界面缩放/坐标换算 ----
test('zoom: 阶梯吸附——平局取较低档；非法值回退 100%；阶梯外夹到端点档', () => {
  assert.equal(normalizeBrowserZoom(0.95), 0.9, '0.9 与 1 等距 → 低档')
  assert.equal(normalizeBrowserZoom(1.05), 1, '1 与 1.1 等距 → 低档（并且 effectiveWebviewZoom(1,1.05) 依赖原值直乘）')
  assert.equal(normalizeBrowserZoom(1.625), 1.5, '1.5 与 1.75 的精确二进制平局 → 低档')
  assert.equal(normalizeBrowserZoom(0.93), 0.9)
  assert.equal(normalizeBrowserZoom(1.07), 1.1)
  for (const bad of [Number.NaN, 0, -1.5]) assert.equal(normalizeBrowserZoom(bad), 1, String(bad))
  assert.equal(normalizeBrowserZoom(0.1), BROWSER_ZOOM_STEPS[0], '阶梯下方夹到端点档')
  assert.equal(normalizeBrowserZoom(100), 3, '阶梯上方夹到端点档')
  assert.equal(normalizeBrowserZoom(Number.POSITIVE_INFINITY), 3)
})

test('zoom: nextBrowserZoom 先吸附再步进，端点停住', () => {
  assert.equal(nextBrowserZoom(1, 1), 1.1)
  assert.equal(nextBrowserZoom(1, -1), 0.9)
  assert.equal(nextBrowserZoom(1.05, 1), 1.1, '1.05 吸附到 1 再放大一档')
  assert.equal(nextBrowserZoom(1.625, 1), 1.75)
  assert.equal(nextBrowserZoom(BROWSER_ZOOM_STEPS[0], -1), BROWSER_ZOOM_STEPS[0], '最小档再缩小停住')
  assert.equal(nextBrowserZoom(3, 1), 3, '最大档再放大停住')
})

test('zoom: effectiveWebviewZoom = 页面档 × 界面缩放（不再整化）；界面缩放非法回退 1', () => {
  assert.equal(effectiveWebviewZoom(1, 1.05), 1.05, '界面 105%、页面 100% → guest 1.05，写成 1 会闪缩')
  assert.equal(effectiveWebviewZoom(1.1, 1.05), 1.1 * 1.05)
  assert.equal(effectiveWebviewZoom(0.93, 2), 0.9 * 2, '页面值先吸附阶梯')
  assert.equal(effectiveWebviewZoom(1, Number.NaN), 1)
  assert.equal(effectiveWebviewZoom(1, 0), 1)
})

test('zoom: hostPointToGuest / guestBoxToHost 换算与往返', () => {
  assert.deepEqual(hostPointToGuest({ x: 250, y: 100 }, 1.25), { x: 200, y: 80 })
  const box = { x: 40, y: 60, width: 300, height: 200 }
  const host = guestBoxToHost(box, 1.5)
  assert.deepEqual(host, { x: 60, y: 90, width: 450, height: 300 })
  // guest 盒中心的 host 坐标换回 guest 坐标 = 原盒中心（同一 scale 两侧相消）
  const center = hostPointToGuest({ x: host.x + host.width / 2, y: host.y + host.height / 2 }, 1.5)
  assert.deepEqual(center, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
})

test('zoom: setBrowserZoom 持久化 + 同值不写盘不通知；getBrowserZoom 空存储回落 100%', () => {
  withWindowShim(({ store, writes }) => {
    let notified = 0
    const stop = subscribeBrowserZoom(() => { notified++ })
    assert.equal(getBrowserZoom(), 1, '空存储回落 100%')
    setBrowserZoom(1.5)
    assert.equal(getBrowserZoom(), 1.5)
    assert.equal(store.get('pi-app:browser-zoom'), '1.5', '键名 pi-app:browser-zoom')
    assert.equal(notified, 1)
    setBrowserZoom(1.5) // 同值：不写盘、不通知
    assert.equal(notified, 1)
    assert.equal(writes.length, 1)
    setBrowserZoom(7) // 阶梯外吸附到端点档
    assert.equal(getBrowserZoom(), 3)
    assert.equal(store.get('pi-app:browser-zoom'), '3')
    stop()
  })
})

// ---- session：纯函数核心（用例取自 $PIWEB/lib/browser-session.test.mjs 语义）----
test('session: upsertRecentUrl 去重置顶、非 http(s) 不入列、超量截断', () => {
  const list = ['https://a.dev/', 'https://b.dev/', 'https://c.dev/']
  assert.deepEqual(upsertRecentUrl(list, 'https://b.dev/'), ['https://b.dev/', 'https://a.dev/', 'https://c.dev/'])
  assert.deepEqual(upsertRecentUrl(list, 'https://d.dev/'), ['https://d.dev/', 'https://a.dev/', 'https://b.dev/', 'https://c.dev/'])
  assert.equal(upsertRecentUrl(list, 'https://a.dev/'), list, '已在顶 → 原引用')
  assert.equal(upsertRecentUrl(list, 'file:///etc'), list, '不可记录 URL → 原引用')
  assert.equal(upsertRecentUrl(list, 'about:blank'), list)
  assert.ok(isRecordableUrl('https://a/'))
  const capped = Array.from({ length: BROWSER_RECENTS_LIMIT }, (_, i) => `https://${i}.dev/`)
  const upserted = upsertRecentUrl(capped, 'https://new.dev/')
  assert.equal(upserted.length, BROWSER_RECENTS_LIMIT, '默认限量 8')
  assert.equal(upserted[0], 'https://new.dev/')
  assert.equal(upserted.at(-1), 'https://6.dev/', '尾部挤出')
})

test('session: pushBrowserHistory——队首同 URL 刷新去重只回填标题，其余前置并限量', () => {
  const t0 = 1000
  const list = pushBrowserHistory([], { url: 'https://a.dev/', title: 'A', at: t0 })
  assert.deepEqual(list, [{ url: 'https://a.dev/', title: 'A', at: t0 }])
  // 队首同 URL：无标题/同标题 → 原引用；新标题 → 回填且 at 不变
  assert.equal(pushBrowserHistory(list, { url: 'https://a.dev/', at: t0 + 5 }), list)
  assert.equal(pushBrowserHistory(list, { url: 'https://a.dev/', title: 'A', at: t0 + 5 }), list)
  const renamed = pushBrowserHistory(list, { url: 'https://a.dev/', title: 'A2', at: t0 + 5 })
  assert.deepEqual(renamed, [{ url: 'https://a.dev/', title: 'A2', at: t0 }])
  // 不同 URL 前置；非 http(s) 原引用
  const two = pushBrowserHistory(renamed, { url: 'https://b.dev/', title: 'B', at: t0 + 10 })
  assert.deepEqual(two.map((e) => e.url), ['https://b.dev/', 'https://a.dev/'])
  assert.equal(pushBrowserHistory(two, { url: 'file:///x', at: t0 }), two)
  let long = []
  for (let i = 0; i < BROWSER_HISTORY_LIMIT + 5; i++) long = pushBrowserHistory(long, { url: `https://${i}.dev/`, at: i })
  assert.equal(long.length, BROWSER_HISTORY_LIMIT, '默认限量 500')
  assert.equal(long[0].url, `https://${BROWSER_HISTORY_LIMIT + 4}.dev/`)
})

test('session: updateBrowserHistoryTitle/Favicon 未命中/空值/无变化保持引用，命中只改目标条', () => {
  const list = [
    { url: 'https://a.dev/', title: 'A', favicon: 'f1', at: 1 },
    { url: 'https://b.dev/', title: 'B', at: 2 },
  ]
  assert.equal(updateBrowserHistoryTitle(list, 'https://c.dev/', 'C'), list, '未命中')
  assert.equal(updateBrowserHistoryTitle(list, 'https://a.dev/', ''), list, '空标题')
  assert.equal(updateBrowserHistoryTitle(list, 'https://a.dev/', 'A'), list, '标题无变化')
  assert.equal(updateBrowserHistoryFavicon(list, 'https://b.dev/', ''), list, '空图标')
  assert.equal(updateBrowserHistoryFavicon(list, 'https://a.dev/', 'f1'), list, '图标无变化')
  const titled = updateBrowserHistoryTitle(list, 'https://b.dev/', 'B2')
  assert.deepEqual(titled[1], { url: 'https://b.dev/', title: 'B2', at: 2 })
  assert.equal(titled[0], list[0], '其余条目引用不变')
  const faved = updateBrowserHistoryFavicon(list, 'https://b.dev/', 'https://b.dev/favicon.ico')
  assert.deepEqual(faved[1], { url: 'https://b.dev/', title: 'B', favicon: 'https://b.dev/favicon.ico', at: 2 })
})

test('session: snapshotOpenPages 只收 human 页与 http(s)，保持顺序并限量', () => {
  const pages = [
    { owner: 'human', url: 'https://h1.dev/' },
    { owner: 'agent:s1', url: 'https://agent.dev/' },
    { owner: 'human', url: 'file:///etc' },
    { owner: 'human', url: 'about:blank' },
    { owner: 'human', url: 'https://h2.dev/' },
  ]
  assert.deepEqual(snapshotOpenPages(pages), ['https://h1.dev/', 'https://h2.dev/'])
  const many = Array.from({ length: OPEN_BROWSER_PAGES_LIMIT + 3 }, (_, i) => ({ owner: 'human', url: `https://${i}.dev/` }))
  const snap = snapshotOpenPages(many)
  assert.equal(snap.length, OPEN_BROWSER_PAGES_LIMIT, '默认限量 12')
  assert.equal(snap[0], 'https://0.dev/', '保持打开顺序')
})

test('session: localStorage 适配——写盘、lastWritten 同值跳写、history 回填与清空', () => {
  withWindowShim(({ store, writes }) => {
    let recentsNotified = 0
    const stopRecents = subscribeBrowserRecents(() => { recentsNotified++ })
    recordRecentUrl('https://a.dev/')
    recordRecentUrl('https://b.dev/')
    recordRecentUrl('https://a.dev/')
    assert.deepEqual(getRecentUrls(), ['https://a.dev/', 'https://b.dev/'])
    assert.equal(recentsNotified, 3, '三次去重置顶都通知')
    recordRecentUrl('https://a.dev/') // 已在顶
    recordRecentUrl('file:///etc') // 不可记录
    assert.equal(recentsNotified, 3, '无变化不通知')
    assert.deepEqual(JSON.parse(store.get('pi-app:browser-recents')), ['https://a.dev/', 'https://b.dev/'])
    recordRecentUrl('https://c.dev/')
    assert.deepEqual(getRecentUrls(), ['https://c.dev/', 'https://a.dev/', 'https://b.dev/'])
    stopRecents()
    // lastWritten 同值跳过：写打开页快照，同值 JSON 不再 setItem
    writeOpenBrowserPages(['https://x.dev/'])
    const n = writes.length
    writeOpenBrowserPages(['https://x.dev/'])
    assert.equal(writes.length, n, '同值派生跳过写盘')
    writeOpenBrowserPages(['https://y.dev/'])
    assert.equal(writes.length, n + 1)
    assert.deepEqual(readOpenBrowserPages(), ['https://y.dev/'], '读回写入值（写入侧只限量不过滤）')
    // 历史：记录、刷新去重、标题回填、清空
    recordBrowserHistory('https://a.dev/', 1)
    recordBrowserHistory('https://a.dev/', 2) // 队首同 URL、无标题 → 原状
    updateBrowserHistoryTitleFor('https://a.dev/', 'Example')
    assert.deepEqual(getBrowserHistory(), [{ url: 'https://a.dev/', title: 'Example', at: 1 }])
    assert.equal(JSON.parse(store.get('pi-app:browser-history')).length, 1)
    clearBrowserHistory()
    assert.deepEqual(getBrowserHistory(), [])
    assert.deepEqual(JSON.parse(store.get('pi-app:browser-history')), [])
  })
})

// ---- device：clampDeviceSize 边界与预设 ----
test('device: clampDeviceSize——非正/NaN/∞ 回 200，超上限夹 3840，先取整再夹取', () => {
  assert.equal(DEVICE_SIZE_MIN, 200)
  assert.equal(DEVICE_SIZE_MAX, 3840)
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(clampDeviceSize(bad), DEVICE_SIZE_MIN, String(bad))
  assert.equal(clampDeviceSize(4000), DEVICE_SIZE_MAX)
  assert.equal(clampDeviceSize(4000.4), DEVICE_SIZE_MAX)
  assert.equal(clampDeviceSize(500.6), 501, '先四舍五入再夹取')
  assert.equal(clampDeviceSize(150), DEVICE_SIZE_MIN, '下限之下夹取')
  assert.equal(clampDeviceSize(375), 375)
  assert.equal(findDevicePreset('iphone-se')?.width, 375)
  assert.equal(findDevicePreset('nope'), null)
  assert.equal(DEVICE_PRESETS.length, 5)
  assert.ok(DEVICE_PRESETS.every((p) => clampDeviceSize(p.width) === p.width && clampDeviceSize(p.height) === p.height))
  assert.equal(CUSTOM_DEVICE_ID, 'custom')
})

// ---- store：useSyncExternalStore 源的队列/乐观页语义 ----
function makeStatus(pages = [], pendingCreates = []) {
  return { available: true, consentRequired: false, pages, pendingCreates }
}

test('store: applyStatus 同引用不通知，异引用通知；getState 在无变更时身份稳定', () => {
  const store = new BrowserStore()
  let notified = 0
  const stop = store.subscribe(() => { notified++ })
  assert.equal(store.getState().status, null)
  const s1 = makeStatus()
  store.applyStatus(s1)
  assert.equal(notified, 1)
  assert.equal(store.getState().status, s1)
  store.applyStatus(s1) // 轮询反复派生的同值：跳过
  assert.equal(notified, 1)
  const stateBefore = store.getState()
  assert.equal(store.getState(), stateBefore, '同一 state 对象在两次通知之间身份稳定')
  store.applyStatus(makeStatus())
  assert.equal(notified, 2)
  assert.notEqual(store.getState(), stateBefore, '变更时整体替换')
  stop()
})

test('store: optimistic 生命周期——add 占位 pending、resolve 解除、remove 移除；未知/重复 id 原样', () => {
  const store = new BrowserStore()
  let notified = 0
  const stop = store.subscribe(() => { notified++ })
  store.addOptimistic('p-opt1')
  const added = store.getState().optimistic
  assert.equal(added.length, 1)
  assert.equal(added[0].id, 'p-opt1')
  assert.equal(added[0].pending, true, '占位 = pendingCreate 物化中')
  assert.equal(added[0].owner, HUMAN_OWNER)
  assert.equal(added[0].url, buildMarkerUrl(HUMAN_OWNER, 'p-opt1'), 'marker URL 可直接物化 webview')
  assert.equal(added[0].title, '')
  store.addOptimistic('p-opt1') // 重复 add：原状
  assert.equal(store.getState().optimistic, added)
  assert.equal(notified, 1)
  store.resolveOptimistic('p-opt1')
  assert.equal(store.getState().optimistic[0].pending, false, '往返完成解除 pending')
  assert.equal(store.getState().optimistic.length, 1)
  store.resolveOptimistic('nope')
  assert.equal(store.getState().optimistic[0].pending, false, '未知 id 原样')
  store.removeOptimistic('nope')
  assert.equal(store.getState().optimistic.length, 1)
  store.removeOptimistic('p-opt1')
  assert.deepEqual(store.getState().optimistic, [])
  stop()
})

test('store: pushPopup/drainPopups——先进先出、drain 清空、空 drain 不通知', () => {
  const store = new BrowserStore()
  let notified = 0
  const stop = store.subscribe(() => { notified++ })
  store.pushPopup({ url: 'https://p1.dev/', openerWebContentsId: 7 })
  store.pushPopup({ url: 'https://p2.dev/', openerWebContentsId: 8 })
  assert.equal(notified, 2)
  assert.deepEqual(store.drainPopups(), [
    { url: 'https://p1.dev/', openerWebContentsId: 7 },
    { url: 'https://p2.dev/', openerWebContentsId: 8 },
  ])
  assert.deepEqual(store.getState().popups, [])
  const n = notified
  assert.deepEqual(store.drainPopups(), [], '空 drain 返回空数组')
  assert.equal(notified, n, '空 drain 不通知')
  stop()
})

test('store: pushDownload 环形 ≤5，保留最新', () => {
  assert.equal(BROWSER_DOWNLOADS_LIMIT, 5)
  const store = new BrowserStore()
  for (let i = 1; i <= 7; i++) store.pushDownload({ path: `/dl/f${i}.bin`, filename: `f${i}.bin` })
  assert.deepEqual(store.getState().downloads.map((d) => d.filename), ['f3.bin', 'f4.bin', 'f5.bin', 'f6.bin', 'f7.bin'])
})

test('store: applyStatus 只换 status 字段，popups/downloads/optimistic 数组引用不变', () => {
  const store = new BrowserStore()
  store.pushPopup({ url: 'https://p.dev/', openerWebContentsId: 1 })
  store.addOptimistic('p-opt9')
  const { popups, downloads, optimistic } = store.getState()
  store.applyStatus(makeStatus())
  const next = store.getState()
  assert.equal(next.popups, popups)
  assert.equal(next.downloads, downloads)
  assert.equal(next.optimistic, optimistic)
})

// ---- open-link：事件名 pith:browser-open-link + 待打开队列 ----
test('open-link: request 入队并派发 pith:browser-open-link；drain 取走并清空', () => {
  withWindowShim(({ events }) => {
    assert.equal(BROWSER_OPEN_LINK_EVENT, 'pith:browser-open-link')
    requestBrowserOpenLink('https://a.dev/')
    requestBrowserOpenLink('https://b.dev/')
    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'pith:browser-open-link')
    assert.deepEqual(drainPendingBrowserOpenLinks(), ['https://a.dev/', 'https://b.dev/'])
    assert.deepEqual(drainPendingBrowserOpenLinks(), [], '再 drain 为空')
  })
})

// ---- popup：window.pi.onBrowserPopup → store.pushPopup 的默认接线 ----
test('popup: 无 window.pi 安全降级；有则转发 pushPopup 且退订移除监听', () => {
  const store = new BrowserStore()
  const previous = globalThis.window
  try {
    delete globalThis.window // node 裸环境：没有 window.pi
    const stop = subscribeBrowserPopups(store)
    assert.equal(typeof stop, 'function')
    stop()
  } finally {
    if (previous !== undefined) globalThis.window = previous
  }
  withWindowShim(() => {
    const listeners = []
    globalThis.window.pi = {
      onBrowserPopup: (cb) => {
        listeners.push(cb)
        return () => { const i = listeners.indexOf(cb); if (i !== -1) listeners.splice(i, 1) }
      },
    }
    const stop = subscribeBrowserPopups(store)
    assert.equal(listeners.length, 1)
    listeners[0]({ url: 'https://pop.dev/', openerWebContentsId: 42 })
    assert.deepEqual(store.getState().popups, [{ url: 'https://pop.dev/', openerWebContentsId: 42 }])
    stop()
    assert.equal(listeners.length, 0, '退订移除监听')
  })
})

// ---- Task 15：open-link 偏好的同步 getter（markdown 链接路由在事件回调里读）----
test('open-link: getOpenLinksInBrowserPref 同步读同一 store；默认开，仅 \'false\' 关，set 即时生效', () => {
  withWindowShim(({ store }) => {
    assert.equal(getOpenLinksInBrowserPref(), true, '默认开（无键）')
    setOpenLinksInBrowser(false)
    assert.equal(getOpenLinksInBrowserPref(), false)
    assert.equal(store.get('pi-app:open-links-in-browser'), 'false')
    setOpenLinksInBrowser(true)
    assert.equal(getOpenLinksInBrowserPref(), true, 'set 后同步 getter 即时读到新值')
  })
})

// ---- Task 15：popup 订阅的 onPopup 观察者（Workspace 自动开面板钩子）----
test('popup: onPopup 在 pushPopup 之后回调（回调里读到的队列已含本条）；缺省时行为不变', () => {
  withWindowShim(() => {
    const listeners = []
    globalThis.window.pi = {
      onBrowserPopup: (cb) => {
        listeners.push(cb)
        return () => { const i = listeners.indexOf(cb); if (i !== -1) listeners.splice(i, 1) }
      },
    }
    const store = new BrowserStore()
    const seen = []
    const stop = subscribeBrowserPopups(store, () => { seen.push(store.getState().popups.length) })
    listeners[0]({ url: 'https://p.dev/', openerWebContentsId: 7 })
    assert.deepEqual(seen, [1], '回调时 popup 已入队——先 push 再回调，回调抛错不丢 popup')
    stop()
    const plain = new BrowserStore()
    const stop2 = subscribeBrowserPopups(plain)
    listeners[0]({ url: 'https://q.dev/', openerWebContentsId: 8 })
    assert.equal(plain.getState().popups.length, 1, '无 onPopup 时与原行为一致')
    stop2()
  })
})

// ---- Task 15：聊天链接拦截源码钉（markdown 锚点渲染器）----
// 语义钉：四修饰键全查、http(s) 门、同步偏好读取、拦截分支在放行分支之前、
// # 锚点分支保持在最前（in-page 滚动行为不变）。
test('markdown interception source pin: 修饰键全查 + http(s) 门 + 偏好门；拦截先于 navigation.open 放行', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/lib/markdown.tsx', import.meta.url),
    'utf8',
  )
  const fnAt = source.indexOf('function isBrowserOpenLinkClick')
  assert.ok(fnAt !== -1, '找不到 isBrowserOpenLinkClick（拦截判定被内联/改名，需随重构更新本钉）')
  const fn = source.slice(fnAt, source.indexOf('type MarkdownComponents', fnAt))
  for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
    assert.ok(fn.includes(key), `修饰键检查缺 ${key}——带修饰键的点击必须保持既有 openExternal 行为`)
  }
  assert.ok(fn.includes('https?:'), '必须门控 http(s)——其他 scheme（file 链接等）走既有路由')
  assert.ok(fn.includes('getOpenLinksInBrowserPref()'), '必须读同步偏好——偏好关时行为不变')
  const anchorAt = source.indexOf("} else if (isBrowserOpenLinkClick(href, event)) {")
  const queueAt = source.indexOf('requestBrowserOpenLink(href)')
  const fallthroughAt = source.indexOf('} else navigation.open(href)')
  const fragmentAt = source.indexOf("if (href.startsWith('#'))")
  assert.ok(anchorAt !== -1 && queueAt !== -1 && fallthroughAt !== -1 && fragmentAt !== -1,
    '锚点 onClick 的分支结构变了——拦截分支必须先于放行分支，# 锚点分支保持最前')
  assert.ok(fragmentAt < anchorAt, '# 锚点分支必须在拦截判断之前（in-page 滚动行为不变）')
  assert.ok(queueAt < fallthroughAt, 'requestBrowserOpenLink 必须在 navigation.open 放行之前')
})

// ---- Task 15：popup 物化源码钉（修正后的流程写死）----
// renderer 绝不自己 loadURL popup（会输掉与 reconcile 的 marker 竞态）：tempId 客户端
// 生成 → 本地 pending 行与 server pendingCreates 走同一 pendingRowOf 分支（Ruling D）→
// dom-ready 握手带 navigateTo → service 存 pendingNavigate 并在 runtime 就位后自行 goto。
test('popup materialization source pin: tempId 客户端生成 + Ruling D 同一分支 + navigateTo 上报 + 渲染端无 loadURL', () => {
  const pane = readFileSync(
    new URL('../src/renderer/src/components/app/BrowserPane.tsx', import.meta.url),
    'utf8',
  )
  const view = readFileSync(
    new URL('../src/renderer/src/components/app/BrowserPageView.tsx', import.meta.url),
    'utf8',
  )
  assert.ok(
    pane.includes('wcIdMapRef.current.get(popup.openerWebContentsId)?.owner ?? HUMAN_OWNER'),
    'owner 继承必须经 wcId→page 映射，查不到回 human',
  )
  assert.ok(pane.includes('createBrowserPageId()'), 'tempId 必须客户端生成（popup 无法预知服务端 id）')
  const modelStart = pane.indexOf('const pages = useMemo')
  assert.ok(modelStart !== -1, '合并模型分支挪走了——源码钉需要随重构更新')
  const model = pane.slice(modelStart, pane.indexOf('}, [state, status, closedIds, localPending])'))
  assert.ok(model.includes('pendingRowOf(entry.id, entry.owner)'), 'server pendingCreates 必须走 pendingRowOf 分支')
  assert.ok(model.includes('pendingRowOf(row.id, row.owner, row.navigateTo)'), '本地 popup 行必须走同一 pendingRowOf 分支（Ruling D：不许第二渲染路径）')
  assert.ok(
    view.includes('navigateTo: page.navigateTo'),
    'dom-ready 握手必须把 pending 行的 navigateTo 上报（service 侧 goto 的唯一通道）',
  )
  assert.ok(!/loadURL\s*\(/.test(pane), 'BrowserPane 不得调用 loadURL——popup 的 goto 只能由 service 执行（注释里的词不算）')
})

// ---- Task 9 评审修复：zoom 生命周期的源码钉（pi-web 前身 BrowserTab.zoom-lifecycle.test.mjs）----
// dom-ready 的缩放重应用是承重规则：guest 的 zoom factor 会在首个 marker→站点导航
// 与后续跨域导航时被重置，所以每个 dom-ready 都必须先无条件重应用 zoom，再过一次
// 性的 browserSeen 握手闩锁（闩锁只管注册）。真实 webview 的时序无法在纯 node 下
// 跑，这里读渲染层源码按顺序钉住——谁把 applyZoom( 挪到闩锁之后，此测试立即失败
// （附两个偏移量，便于定位）。
test('zoom-lifecycle source pin: dom-ready 内的 applyZoom( 必须先于 handshakeCompleteRef 闩锁（源码顺序）', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/app/BrowserPageView.tsx', import.meta.url),
    'utf8',
  )
  const domReadyAt = source.indexOf('const onDomReady = () => {')
  const onNavAt = source.indexOf('const onNav = (event: Event) => {')
  assert.ok(domReadyAt !== -1, 'BrowserPageView 源码里找不到 dom-ready 处理器（const onDomReady = () => {）——源码钉需要随重构更新')
  assert.ok(onNavAt > domReadyAt, 'onNav 应在 dom-ready 处理器之后（切片边界失效，源码钉需要随重构更新）')
  const handler = source.slice(domReadyAt, onNavAt)
  const applyZoomAt = handler.indexOf('applyZoom(')
  const latchAt = handler.indexOf('handshakeCompleteRef')
  assert.ok(applyZoomAt !== -1, 'dom-ready 处理器内必须有 applyZoom( 调用——删掉它，跨域导航后会以重置的缩放闪现')
  assert.ok(latchAt !== -1, 'dom-ready 处理器内必须有 handshakeCompleteRef 闩锁检查（browserSeen 注册是一次性的）')
  assert.ok(
    applyZoomAt < latchAt,
    `dom-ready 的 applyZoom(（偏移 ${applyZoomAt}）必须出现在 handshakeCompleteRef 闩锁检查（偏移 ${latchAt}）之前` +
      '——闩锁只管 browserSeen 注册，缩放重应用必须无条件先行，否则首个 marker→站点导航的 dom-ready 不再重应用缩放',
  )
})

// ---- Task 10：agent 工具（tools.ts 纯函数）----

test('browser tool names: 13 个、与 tools-core 的 BROWSER_TOOL_NAMES 一致、无重复', () => {
  assert.equal(APP_BROWSER_TOOL_NAMES.length, 13)
  assert.deepEqual([...new Set(APP_BROWSER_TOOL_NAMES)], [...BROWSER_TOOL_NAMES])
  const tools = createBrowserTools({ ownerId: 's1', service: {} })
  assert.equal(tools.length, 13)
  assert.deepEqual(tools.map((t) => t.name), [...BROWSER_TOOL_NAMES])
  for (const tool of tools) {
    assert.equal(tool.executionMode, 'sequential', `${tool.name} 必须顺序执行`)
    assert.ok(tool.description.length > 0, `${tool.name} 缺描述`)
  }
  const navigate = tools.find((t) => t.name === 'browser_navigate')
  assert.match(navigate.description, /untrusted data/, 'navigate 描述必须携带不可信数据声明')
  const screenshot = tools.find((t) => t.name === 'browser_screenshot')
  assert.match(screenshot.description, /JPEG/, 'screenshot 描述声明 JPEG')
})

test('browserToolErrorText：每个错误类 → 目标文本前缀', () => {
  assert.match(browserToolErrorText(new ConsentRequiredError()),
    /^consentRequired: .+open the Browser pane .+never confirm on the user's behalf\.$/)
  assert.match(browserToolErrorText(new BrowserHostUnavailableError()),
    /^browserHostUnavailable: .+retry once.+open the Browser tab/)
  assert.match(browserToolErrorText(new NavigationBlockedError('file:///etc')),
    /^navigationBlocked: .+Only http\/https and about:blank are supported\.$/)
  assert.match(browserToolErrorText(new SnapshotScopeError('no match for selector')),
    /^error: no match for selector$/)
  assert.match(browserToolErrorText(new StaleSnapshotError('ref e5 stale')),
    /^error: ref e5 stale$/)
  assert.match(browserToolErrorText(new InvalidRefError('e99')),
    /^error: invalid ref: e99$/)
  assert.match(browserToolErrorText(new PageGoneError('p-1')),
    /^error: page is gone: p-1 .+browser_navigate/)
  assert.match(browserToolErrorText(new PageNotFoundError('p-2')),
    /^error: unknown page: p-2$/)
  // generic Error → 首行；非 Error → 原样抛出
  assert.equal(browserToolErrorText(new Error('boom\nsecond line')), 'error: boom')
  assert.throws(() => browserToolErrorText('bare string'))
})

test('validateNavigateParams：url/action 互斥、newPage 不与 action 同用、必须给其一', () => {
  assert.equal(validateNavigateParams({ url: 'https://a.b/' }), null)
  assert.equal(validateNavigateParams({ action: 'back' }), null)
  assert.equal(validateNavigateParams({ url: 'https://a.b/', newPage: true }), null)
  assert.match(validateNavigateParams({ url: 'https://a.b/', action: 'reload' }), /^error: /)
  assert.match(validateNavigateParams({ action: 'back', newPage: true }), /^error: /)
  assert.match(validateNavigateParams({}), /^error: /)
  assert.match(validateNavigateParams({ newPage: true }), /^error: /)
})

// service 套件的挂起 promise（建页握手 waiter、autoMaterialize 轮询、notify 合并窗）
// 都依赖 unref 定时器——ref 一个保活定时器撑住事件循环，套件结束后撤销；
// 若某用例真的挂死，120s 后保活到期、事件循环清空、进程自然退出。
const serviceSuiteKeepalive = setTimeout(() => {}, 120_000)

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  ok - ${name}`) } catch (e) { failed++; console.error(`  FAIL - ${name}\n${e.message}`) }
}
clearTimeout(serviceSuiteKeepalive)
if (failed) { console.error(`${failed} failing`); process.exit(1) }
console.log(`${tests.length} passing`)
