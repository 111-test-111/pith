#!/usr/bin/env node
// 内嵌浏览器移植的纯逻辑检查（无 Electron）。用法：node scripts/check-browser.mjs
// （node ≥ 22.6 需 `node --experimental-strip-types` 跑 .ts import；≥ 23.6 直接跑。）
import assert from 'node:assert/strict'
import {
  BROWSER_MARKER_PREFIX, buildMarkerUrl, parseMarkerUrl,
  normalizeNavigationUrl, isAllowedNavigationUrl, agentOwner, HUMAN_OWNER,
} from '../src/shared/browser.ts'

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

let failed = 0
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok - ${name}`) } catch (e) { failed++; console.error(`  FAIL - ${name}\n${e.message}`) }
}
if (failed) { console.error(`${failed} failing`); process.exit(1) }
console.log(`${tests.length} passing`)
