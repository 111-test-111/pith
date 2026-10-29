/** Actual disk metadata, hard links/sparse files, CPU counters and host process
 * trees. No provider calls, application-data mutation or source-string checks. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, open, link, symlink, lstat, readdir, chmod, realpath, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repo = fileURLToPath(new URL('..', import.meta.url)), temp = await mkdtemp(join(tmpdir(), 'pith-resources-'))
let child
try {
  const module = join(temp, 'resources.mjs')
  await build({ stdin: { contents: "export * from './src/main/resources/storage'; export * from './src/main/resources/processes'; export * from './src/main/resources/runtime'; export * from './src/renderer/src/lib/resource-format';", resolveDir: repo }, outfile: module, bundle: true, platform: 'node', format: 'esm' })
  const { scanStorage, storageCategory, RuntimeSampler, parseCpuTime, parsePs, linuxCpu, parseWindowsProcesses, descendants, collectProcessTree, resourceBytes } = await import(pathToFileURL(module))
  const appData = join(temp, 'data'), agentData = join(temp, 'agent'), library = join(temp, 'external archive'), sessionData = join(temp, 'browser'), logs = join(temp, 'logs')
  const options = { appData, agentData, library, sessionData, roots: [
    { kind: 'app', path: appData }, { kind: 'pi', path: agentData }, { kind: 'library', path: library },
    { kind: 'browser', path: sessionData }, { kind: 'logs', path: logs }, { kind: 'crashes', path: join(temp, 'not-created') },
    { kind: 'library', path: join(appData, 'library') }, { kind: 'app', path: appData }
  ] }
  const data = new Map([
    [join(agentData, 'sessions', 'project', 'chat.jsonl'), Buffer.from('会话\n{"secret":"never-read"}\n')],
    [join(agentData, 'skills', 'one', 'SKILL.md'), Buffer.from('A skill')], [join(agentData, 'auth.json'), Buffer.from('private-data')],
    [join(appData, 'trajectory.sqlite'), Buffer.alloc(41)], [join(appData, 'trajectory.sqlite-wal'), Buffer.alloc(79)],
    [join(appData, 'trajectory.sqlite-shm'), Buffer.alloc(23)], [join(appData, 'session-search.sqlite-wal'), Buffer.alloc(29)],
    [join(appData, 'library.sqlite'), Buffer.alloc(67)], [join(appData, 'library', 'objects', 'old.bin'), Buffer.alloc(19)],
    [join(library, 'objects', 'copy.bin'), Buffer.alloc(97)], [join(sessionData, 'Partitions', 'pith-browser', 'Cookies'), Buffer.alloc(31)],
    [join(sessionData, 'Partitions', 'pith-browser', 'Cache', 'Cache_Data', 'blob'), Buffer.alloc(71)],
    [join(appData, 'rewind', 'blobs', 'one'), Buffer.alloc(89)], [join(appData, 'workspace', 'generated.png'), Buffer.alloc(37)],
    [join(appData, 'bash-tasks', 'task.log'), Buffer.alloc(17)], [join(logs, 'main.log'), Buffer.alloc(43)],
    [join(appData, 'unknown-new-persistence', 'record'), Buffer.alloc(59)], [join(appData, 'app-settings.json'), Buffer.from('{}')]
  ])
  for (const [path, bytes] of data) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, bytes) }
  const sparse = join(appData, 'unknown-new-persistence', 'sparse.bin'), handle = await open(sparse, 'w')
  await handle.truncate(16 * 1024 ** 2); await handle.close()
  await link(join(agentData, 'sessions', 'project', 'chat.jsonl'), join(library, 'objects', 'hard-link.jsonl'))
  let extraLinkBytes = 0, extraLinks = 0
  if (process.platform !== 'win32') {
    const outside = join(temp, 'outside-project'); await mkdir(outside); await writeFile(join(outside, 'ignored.bin'), Buffer.alloc(8192))
    for (const [path, target] of [[join(appData, 'outside-link'), outside], [join(appData, 'loop'), appData], [join(agentData, 'broken-link'), join(temp, 'missing-target')]]) {
      await symlink(target, path); extraLinkBytes += Number((await lstat(path)).size); extraLinks++
    }
    const alias = join(temp, 'pi-alias'); await symlink(agentData, alias)
    options.roots.push({ kind: 'pi', path: alias })
  }
  const scan = await scanStorage(options)
  assert.equal(scan.partial, false)
  assert.equal(scan.logicalBytes, [...data.values()].reduce((sum, bytes) => sum + bytes.length, 0) + 16 * 1024 ** 2 + extraLinkBytes)
  assert.equal(scan.files, data.size + 1 + extraLinks, 'overlapping roots and hard links are counted only once')
  assert(scan.roots.some(root => root.status === 'missing'))
  assert.equal(scan.entries.reduce((sum, entry) => sum + entry.logicalBytes, 0), scan.logicalBytes)
  assert.equal(scan.entries.find(entry => entry.category === 'sessions').logicalBytes, data.get(join(agentData, 'sessions', 'project', 'chat.jsonl')).length,
    'cross-category hard links have stable session attribution')
  assert.equal(scan.entries.find(entry => entry.category === 'trajectory').logicalBytes, 41 + 79 + 23, 'SQLite sidecars are included')
  assert.equal(scan.entries.find(entry => entry.category === 'library').logicalBytes, 67 + 19 + 97, 'both external archive and old default archive are measured')
  assert.equal(scan.entries.find(entry => entry.category === 'cache').logicalBytes, 71)
  assert.equal(storageCategory(join(appData, 'unknown'), { ...options, sessionData: appData }), 'other', 'shared Chromium userData does not swallow unrelated files')
  if (process.platform !== 'win32') {
    const seen = new Set(); let allocated = 0
    const oracle = async path => {
      const info = await lstat(path), key = `${info.dev}:${info.ino}`
      if (seen.has(key)) return
      seen.add(key); allocated += info.blocks * 512
      if (info.isDirectory()) for (const name of await readdir(path)) await oracle(join(path, name))
    }
    for (const path of [appData, agentData, library, sessionData, logs]) await oracle(await realpath(path))
    assert.equal(scan.allocatedBytes, allocated, 'allocated bytes match an independent inode/block oracle, including directories')
    assert.equal(scan.entries.reduce((sum, entry) => sum + entry.allocatedBytes, 0), allocated)
    assert(scan.allocatedBytes < scan.logicalBytes, 'sparse file lengths are not confused with disk allocation')
    const blocked = join(appData, 'blocked'); await mkdir(blocked); await writeFile(join(blocked, 'secret'), 'inaccessible'); const blockedCanonical = await realpath(blocked); await chmod(blocked, 0)
    try {
      const partial = await scanStorage(options)
      assert.equal(partial.partial, true)
      assert(partial.issues.some(issue => issue.path === blockedCanonical && issue.reason === 'unreadable'))
    } finally { await chmod(blocked, 0o700) }
  }
  const unsupported = await scanStorage(options, false)
  assert.equal(unsupported.allocatedBytes, null)
  assert(unsupported.entries.every(entry => entry.allocatedBytes === null), 'unsupported allocation never becomes a fabricated zero')
  await appendFile(join(agentData, 'sessions', 'project', 'chat.jsonl'), '追加')
  const refreshed = await scanStorage(options)
  assert.equal(refreshed.logicalBytes, scan.logicalBytes + Buffer.byteLength('追加') + (process.platform === 'win32' ? 0 : 'inaccessible'.length))

  const metric = (pid, seconds, creationTime = 1) => ({ pid, creationTime, type: 'Browser', cpu: { cumulativeCPUUsage: seconds, percentCPUUsage: 9999 }, memory: { workingSetSize: 123 } })
  const sampler = new RuntimeSampler()
  assert.equal(sampler.sample([metric(1, 10)], [], false, 8, 10_000, 1000).cpuPercent, null, 'first sample does not claim zero CPU')
  const active = sampler.sample([metric(1, 14)], [], false, 8, 12_000, 3000)
  assert.equal(active.cpuPercent, 200, 'CPU is based on cumulative seconds and one core equals 100%, independent of Electron interval callers')
  assert.equal(active.residentBytes, 123 * 1024, 'Electron memory is KiB, not bytes')
  const old = sampler.sample([metric(1, 0.5, 2)], [], false, 8, 14_000, 5000)
  assert.equal(old.cpuPercent, null, 'PID reuse never subtracts the preceding process counter')
  const fresh = new RuntimeSampler(), baseline = metric(1, 1)
  fresh.sample([baseline], [], false, 4, 10_000, 0)
  const newborn = fresh.sample([metric(1, 2), metric(2, 0.25, 11_000)], [], false, 4, 12_000, 2000)
  assert.equal(newborn.cpuPercent, 62.5, 'new processes contribute only their actual lifetime CPU within the interval')
  const native = { pid: 3, parentPid: 1, creationTime: 1, identity: 'native-start', name: 'node', cpuSeconds: 2, residentBytes: 555 }
  const linuxMetric = { ...metric(3, 2), memory: undefined }
  const fallback = new RuntimeSampler().sample([linuxMetric], [native], false, 4, 100, 100)
  assert.equal(fallback.processes.length, 1, 'native census and Electron rows never double count')
  assert.equal(fallback.residentBytes, 555, 'Linux memory and native RSS survive missing Electron memory')
  assert.equal(new RuntimeSampler().sample([metric(1, 2)], [], true, 4).residentBytes, null, 'partial process coverage cannot publish a full total')
  assert.equal(parseCpuTime('1-02:03:04.50'), 93784.5)
  assert.equal(parseCpuTime('12:34.56'), 754.56)
  const ps = parsePs(' 42 1 12345 0:02.34 Fri Oct 9 01:23:11 2026 /path with spaces/node\n')
  assert.equal(ps[0].residentBytes, 12345 * 1024); assert.equal(ps[0].cpuSeconds, 2.34); assert.equal(ps[0].name, 'node')
  const fields = Array(22).fill('0'); fields[11] = '125'; fields[12] = '75'; fields[19] = '990'
  assert.deepEqual(linuxCpu('42 (name with ) parentheses) ' + fields.join(' '), 100), { cpuSeconds: 2, identity: '990' })
  assert.equal(parseWindowsProcesses(JSON.stringify([{ pid: 42, parentPid: 1, creationTime: 100, name: 'node.exe', cpuSeconds: 1.25, residentBytes: 54321 }]))[0].residentBytes, 54321)
  const tree = [native, { ...native, pid: 4, parentPid: 3 }, { ...native, pid: 5, parentPid: 88 }, { ...native, pid: 6, parentPid: 1 }, { ...native, pid: 7, parentPid: 6 }]
  assert.deepEqual(descendants(tree, new Set([1]), 6).map(row => row.pid), [3, 4], 'nested descendants are included, unrelated and census processes are excluded')
  assert.equal(resourceBytes(1024 ** 3, 'en'), '1 GiB'); assert.equal(resourceBytes(0, 'en'), '0 B')

  child = spawn(process.execPath, ['-e', "const bytes=Buffer.alloc(8*1024*1024,1);console.log('ready');setInterval(()=>{const end=Date.now()+40;while(Date.now()<end){};void bytes[0]},100)"], { stdio: ['ignore', 'pipe', 'inherit'] })
  await once(child.stdout, 'data')
  const live = await collectProcessTree(new Set([process.pid]))
  const owned = live.processes.find(row => row.pid === child.pid)
  assert(owned && owned.residentBytes > 0 && owned.cpuSeconds !== null, 'host adapter measures a real launched process')
  assert(!live.processes.some(row => row.name === 'ps'), 'resource census does not count its own helper')
  const abort = new AbortController(); abort.abort()
  await assert.rejects(collectProcessTree(new Set([process.pid]), abort.signal), { name: 'AbortError' }, 'quit can cancel an in-flight census')
  console.log('PASS resources: exact bytes/blocks, sparse files, scope, hard links, partial scans, CPU identity, units and live process tree')
} finally {
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit') }
  await rm(temp, { recursive: true, force: true })
}
