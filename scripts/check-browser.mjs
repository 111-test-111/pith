#!/usr/bin/env node
// 内嵌浏览器移植的纯逻辑检查（无 Electron）。用法：node scripts/check-browser.mjs
// （node ≥ 22.6 需 `node --experimental-strip-types` 跑 .ts import；≥ 23.6 直接跑。）
import assert from 'node:assert/strict'
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
  BrowserService, BrowserHostUnavailableError, ConsentRequiredError, NavigationBlockedError,
  StaleSnapshotError, __setBrowserServiceForTests, getBrowserService, initBrowserService,
} from '../src/main/browser/service.ts'

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
