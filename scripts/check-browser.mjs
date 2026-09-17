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

let failed = 0
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok - ${name}`) } catch (e) { failed++; console.error(`  FAIL - ${name}\n${e.message}`) }
}
if (failed) { console.error(`${failed} failing`); process.exit(1) }
console.log(`${tests.length} passing`)
