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
  const { canReorderSession, reorderSession, orderSessions, toggleSessionPin, forgetSidebarSessions, parseSidebarPreferences,
    assignSessionGroup, setSessionArchived, setSessionUnread, buildSidebarGroups, canMoveSidebarResource, reorderSidebarResource,
    loadSidebarPreferences, saveSidebarPreferences, PROJECTS_GROUP, CHATS_GROUP } = await import(pathToFileURL(outfile).href)
  const session = (path, cwd, timestamp) => ({ path, id: path, label: path, cwd, projectless: cwd === '/private/workspace', running: false, messageCount: 2, created: new Date(timestamp).toISOString(), modified: new Date(timestamp).toISOString() })
  const all = [
    ...Array.from({ length: 8 }, (_, i) => session(`a${i}`, '/one/project', 8000 - i * 1000)),
    session('b0', '/two/project', 10_000), session('b1', '/two/project', 9000),
    session('c0', '/private/workspace', 8000), session('c1', '/private/workspace', 7000)
  ]
  const sessions = new Map(all.map((s) => [s.path, s]))
  const before = JSON.stringify(all)
  const move = (itemId, targetId, position = 'after') => ({ itemId, targetId, position })
  let prefs = parseSidebarPreferences(null)
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
  const defaults = parseSidebarPreferences(null)
  for (const value of [null, '{', 'null', '7', '[]']) assert.deepEqual(parseSidebarPreferences(value), defaults)
  assert.deepEqual(parseSidebarPreferences('{"pinned":["a","a",null,42,""],"order":{}}'), { ...defaults, pinned: ['a'] })
  const legacy = parseSidebarPreferences(JSON.stringify({ pinned: ['a1'], order: ['a0', 'a1'] }))
  assert.equal(legacy.sort, 'manual', 'upgrades preserve an existing manually arranged sidebar')
  assert.deepEqual(legacy.pinned, ['a1'])
  assert.deepEqual(legacy.order, ['a0', 'a1'])

  const folders = ['/one/project', '/two/project'].map((cwd) => ({ cwd, sessions: all.filter((s) => s.cwd === cwd) }))
  const paths = (groups) => groups.flatMap((group) => group.children ? paths(group.children) : group.sessions.map((s) => s.path))
  let rich = { ...defaults, sort: 'manual', groups: [{ id: 'group:review', name: 'Review', sessions: [] }, { id: 'group:later', name: 'Later', sessions: [] }] }
  rich = assignSessionGroup(rich, 'a0', 'group:review')
  rich = assignSessionGroup(rich, 'b0', 'group:review')
  rich = assignSessionGroup(rich, 'c0', 'group:review')
  rich = toggleSessionPin(rich, 'a0')
  rich = setSessionUnread(rich, 'a0', true)
  const unarchived = structuredClone(rich)
  rich = setSessionArchived(rich, 'a0', true)
  rich = parseSidebarPreferences(JSON.stringify(rich))
  for (const view of ['projects', 'groups', 'timeline']) {
    const listed = paths(buildSidebarGroups(all, folders, { ...rich, view }))
    assert(!listed.includes('a0'), view + ': archive hides even pinned sessions')
    assert.equal(new Set(listed).size, listed.length, view + ': each session appears only once')
    assert.deepEqual(paths(buildSidebarGroups(all, folders, { ...rich, view }, { archived: true })), ['a0'], view + ': archive stays accessible')
  }
  assert.equal(JSON.stringify(all), before, 'archive/group/unread actions leave SDK data untouched')
  rich = setSessionArchived(rich, 'a0', false)
  assert.deepEqual(rich, unarchived, 'unarchive restores pin, group, unread mark and manual position')
  rich = assignSessionGroup(rich, 'a0', 'group:later')
  assert(!rich.groups[0].sessions.includes('a0'))
  assert(rich.groups[1].sessions.includes('a0'))
  assert.equal(assignSessionGroup(rich, 'a0', 'group:missing'), rich, 'unknown group never removes the existing assignment')
  rich = assignSessionGroup(rich, 'a0', null)
  assert(!rich.groups.some((group) => group.sessions.includes('a0')))
  assert(!canMoveSidebarResource({ ...rich, view: 'groups', pinned: [], groups: [{ id: 'group:a', name: 'a', sessions: ['a0'] }] }, sessions, move('a0', 'a1')), 'drag never changes custom group membership')
  assert(!canMoveSidebarResource({ ...rich, sort: 'updated', pinned: [] }, sessions, move('a0', 'a1')), 'date-sorted rows reject manual moves')
  assert(!canMoveSidebarResource({ ...rich, view: 'timeline', pinned: [] }, sessions, move('a0', 'a1')), 'timeline rows reject manual moves')
  assert(!canMoveSidebarResource(rich, sessions, move('a0', 'a1'), true), 'archive has no drag side effects')
  const projectMove = move('folder:/one/project', 'folder:/two/project')
  assert(canMoveSidebarResource(rich, sessions, projectMove))
  rich = reorderSidebarResource(rich, sessions, projectMove, folders)
  assert.deepEqual(rich.projectOrder, ['/two/project', '/one/project'])
  rich = reorderSidebarResource(rich, sessions, move(PROJECTS_GROUP, CHATS_GROUP), folders)
  assert.deepEqual(rich.sectionOrder, [CHATS_GROUP, PROJECTS_GROUP])
  const grouped = { ...rich, view: 'groups' }
  assert.deepEqual(reorderSidebarResource(grouped, sessions, move('group:review', 'group:later'), folders).groups.map((g) => g.id), ['group:later', 'group:review'])
  rich = forgetSidebarSessions(rich, new Set(['a0', 'b0']))
  assert(!rich.pinned.includes('a0') && !rich.unread.includes('a0') && !rich.groups.some((group) => group.sessions.includes('b0')), 'deletion clears all presentation references')

  const byCreation = [{ ...all[0], created: new Date(1).toISOString(), modified: new Date(1e10).toISOString() }, { ...all[1], created: new Date(1e8).toISOString(), modified: new Date(10).toISOString() }]
  assert.deepEqual(orderSessions(byCreation, [], 'updated').map((s) => s.path), ['a0', 'a1'])
  assert.deepEqual(orderSessions(byCreation, [], 'created').map((s) => s.path), ['a1', 'a0'])
  assert.deepEqual(paths(buildSidebarGroups(all, folders, defaults, { query: '/private/workspace' })), [], 'projectless internal paths are never filterable')
  assert.deepEqual(paths(buildSidebarGroups(all, folders, defaults, { query: 'Ｂ０' })), ['b0'], 'title filtering normalizes full-width text')
  assert.deepEqual(paths(buildSidebarGroups(all, folders, { ...defaults, filter: 'running' }, { runningPaths: new Set(['b0']) })), ['b0'], 'live state is included before index refresh')
  assert.deepEqual(paths(buildSidebarGroups(all, folders, { ...defaults, filter: 'unread', unread: ['c1'] })), ['c1'])
  const day = new Date(2026, 9, 4, 12)
  const yesterday = new Date(day); yesterday.setDate(day.getDate() - 1)
  const timeline = buildSidebarGroups([{ ...all[0], modified: day.toISOString() }, { ...all[1], modified: yesterday.toISOString() }], folders, { ...defaults, view: 'timeline' }, { now: day })
  assert.deepEqual(timeline.map((group) => group.kind), ['today', 'yesterday'])
  const invalid = parseSidebarPreferences(JSON.stringify({ view: 'bogus', sort: 'bogus', filter: 'bogus', groups: [{ id: 'group:a', name: ' a ', sessions: ['a0', 'a0'] }, { id: 'group:b', name: 'b', sessions: ['a0', 'b0'] }, { id: 'group:a', name: 'duplicate' }, { id: 'folder:path', name: 'invalid' }], sectionOrder: [CHATS_GROUP, CHATS_GROUP, 'bogus'] }))
  assert.deepEqual(invalid.groups, [{ id: 'group:a', name: 'a', sessions: ['a0'] }, { id: 'group:b', name: 'b', sessions: ['b0'] }])
  assert.deepEqual(invalid.sectionOrder, [CHATS_GROUP, PROJECTS_GROUP])
  assert.equal(invalid.view, 'projects')
  const storage = new Map()
  globalThis.window = { localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } }
  saveSidebarPreferences({ ...rich, archived: ['c0'], collapsed: ['group:review'], view: 'groups' })
  assert.deepEqual(loadSidebarPreferences(), { ...rich, archived: ['c0'], collapsed: ['group:review'], view: 'groups' }, 'archive, groups and collapse survive storage reload')
  globalThis.window.localStorage.getItem = () => { throw new Error('blocked') }
  assert.deepEqual(loadSidebarPreferences(), defaults, 'unavailable storage does not prevent startup')
  delete globalThis.window
  console.log('PASS: ordering, migration, grouping, archive/restore, filtering, creation dates, membership constraints and restart persistence.')
} finally {
  await rm(temp, { recursive: true, force: true })
}
