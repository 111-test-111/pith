// Presentation rules only; all fixtures are in memory and temporary files.
// Run: node scripts/check-session-sidebar.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'pith-sidebar-check-'))
try {
  const outfile = join(temp, 'sidebar.mjs')
  await build({ entryPoints: [resolve('src/renderer/src/lib/session-sidebar.ts')], bundle: true, platform: 'node', format: 'esm', outfile })
  const { canReorderSession, reorderSession, orderSessions, toggleSessionPin, forgetSidebarSessions, parseSidebarPreferences } = await import(pathToFileURL(outfile).href)
  const session = (path, cwd, timestamp) => ({ path, cwd, modified: new Date(timestamp).toISOString() })
  const all = [
    ...Array.from({ length: 8 }, (_, i) => session(`a${i}`, '/one/project', 8000 - i * 1000)),
    session('b0', '/two/project', 10_000), session('b1', '/two/project', 9000),
    session('c0', '/private/workspace', 8000), session('c1', '/private/workspace', 7000)
  ]
  const sessions = new Map(all.map((s) => [s.path, s]))
  const before = JSON.stringify(all)
  const move = (itemId, targetId, position = 'after') => ({ itemId, targetId, position })
  let prefs = { pinned: [], order: [] }
  for (const request of [move('a0', 'b0'), move('a0', 'c0'), move('a0', null), move('a0', 'a1', 'inside'),
    move('folder:/one/project', 'folder:/two/project'), move('a0', 'more:folder:/one/project'), move('a0', 'a0')]) {
    assert(!canReorderSession(request, sessions, new Set()))
    assert.equal(reorderSession(prefs, sessions, request), prefs)
  }
  prefs = reorderSession(prefs, sessions, move('a0', 'a4'))
  const group = all.filter((s) => s.cwd === '/one/project')
  assert.deepEqual(orderSessions(group, prefs.order).map((s) => s.path), ['a1', 'a2', 'a3', 'a4', 'a0', 'a5', 'a6', 'a7'])
  assert.equal(prefs.order.length, 8, 'pagination must preserve hidden rows')
  const reloaded = parseSidebarPreferences(JSON.stringify(prefs))
  const refreshed = group.map((s) => ({ ...s, modified: new Date(s.path === 'a7' ? 1e9 : 0).toISOString() }))
  assert.deepEqual(orderSessions(refreshed, reloaded.order).map((s) => s.path), prefs.order)
  assert.equal(orderSessions([...refreshed, session('new', '/one/project', 1e10)], prefs.order)[0].path, 'new')
  prefs = toggleSessionPin(prefs, 'a0')
  prefs = toggleSessionPin(prefs, 'b0')
  assert.deepEqual(prefs.pinned, ['b0', 'a0'])
  assert(!canReorderSession(move('a0', 'a1'), sessions, new Set(prefs.pinned)), 'pin/unpin must be explicit')
  assert(!canReorderSession(move('a0', 'b0'), sessions, new Set(prefs.pinned)), 'project boundary also holds in the pinned section')
  prefs = toggleSessionPin(prefs, 'a1')
  prefs = reorderSession(prefs, sessions, move('a1', 'a0'))
  assert.deepEqual(prefs.pinned, ['b0', 'a0', 'a1'])
  prefs = toggleSessionPin(prefs, 'a0')
  assert.deepEqual(orderSessions(group, prefs.order).map((s) => s.path), reloaded.order, 'unpin restores original project position')
  prefs = reorderSession(prefs, sessions, move('c0', 'c1'))
  assert.deepEqual(orderSessions(all.filter((s) => s.cwd === '/private/workspace'), prefs.order).map((s) => s.path), ['c1', 'c0'])
  prefs = forgetSidebarSessions(prefs, new Set(['b0', 'a1']))
  assert(!prefs.pinned.includes('b0') && !prefs.order.includes('a1'))
  assert.equal(JSON.stringify(all), before, 'no SDK session data may be changed')
  for (const value of [null, '{', 'null', '7', '[]']) assert.deepEqual(parseSidebarPreferences(value), { pinned: [], order: [] })
  assert.deepEqual(parseSidebarPreferences('{"pinned":["a","a",null,42,""],"order":{}}'), { pinned: ['a'], order: [] })
  console.log('PASS: fixed ownership, pointer/keyboard move policy, hidden rows, restart persistence, pin/unpin, projectless ordering and invalid saved preferences.')
} finally {
  await rm(temp, { recursive: true, force: true })
}
