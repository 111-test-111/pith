/** Desktop FFF compatibility, with an optional installed-extension smoke test.
 * PI_FFF_EXTENSION_PATH=/path/to/pi-fff/src/index.ts node scripts/check-extension-startup.mjs
 * All settings, sessions, databases and search files stay in a temporary folder.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = await mkdtemp(join(tmpdir(), 'pith-extension-startup-'))
let session
try {
  const outfile = join(temporary, 'startup.mjs')
  await build({ entryPoints: [resolve('src/main/pi/extension-startup.ts')], bundle: true,
    platform: 'node', format: 'esm', outfile })
  const { desktopExtension } = await import(pathToFileURL(outfile).href)
  let prepared = 0, scans = 0
  const prepare = (_event, ctx) => { assert.equal(ctx.owner, 'fixture'); prepared++ }
  const eager = async () => { scans++ }
  const makeExtension = async (name, version) => {
    const root = join(temporary, `${name.replaceAll('/', '-')}-${version}`)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name, version }))
    return { path: join(root, 'src/index.ts'), resolvedPath: join(root, 'src/index.ts'),
      handlers: new Map([['session_start', [eager]], ['before_agent_start', [prepare]], ['session_shutdown', [() => {}]]]),
      tools: new Map(), flags: new Map() }
  }
  const extension = await makeExtension('@ff-labs/pi-fff', '0.10.6')
  const desktop = desktopExtension(extension)
  assert.notEqual(desktop, extension)
  assert.equal(desktopExtension(extension), desktop, 'adapter preserves runner identity')
  assert.equal(desktop.tools, extension.tools, 'catalog and runtime share lazy registrations')
  assert.equal(desktop.handlers.get('session_shutdown'), extension.handlers.get('session_shutdown'))
  await desktop.handlers.get('session_start')[0]({ type:'session_start' }, { owner:'fixture' })
  assert.equal(prepared, 1)
  assert.equal(scans, 0)
  assert.equal(extension.handlers.get('session_start')[0], eager, 'unfiltered loader stays untouched')
  for (const [name, version] of [['other-extension', '0.10.6'], ['@ff-labs/pi-fff', '0.10.7']]) {
    const other = await makeExtension(name, version)
    assert.equal(desktopExtension(other), other, 'unknown preparation contracts keep their lifecycle')
  }
  const changed = await makeExtension('@ff-labs/pi-fff', '0.10.6')
  changed.handlers.set('before_agent_start', [])
  assert.equal(desktopExtension(changed), changed)
  console.log('PASS: version-bounded FFF preparation skips eager indexing, keeps catalog/runner ownership and leaves other extensions unchanged.')

  if (process.env.PI_FFF_EXTENSION_PATH) {
    const agentDir = join(temporary, 'agent'), project = join(temporary, 'project')
    await mkdir(agentDir); await mkdir(project)
    await writeFile(join(project, 'startup-fixture.txt'), 'unique_startup_search_marker\n')
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.FFF_FRECENCY_DB = join(temporary, 'frecency')
    process.env.FFF_HISTORY_DB = join(temporary, 'history')
    const { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent')
    const runtime = await ModelRuntime.create({ authPath:join(agentDir,'auth.json'), modelsPath:join(agentDir,'models.json'), refreshOnCreate:false })
    const services = await createAgentSessionServices({ cwd:project, agentDir, modelRuntime:runtime,
      settingsManager:SettingsManager.inMemory({ compaction:{enabled:false}, retry:{enabled:false} }),
      resourceLoaderOptions:{ noExtensions:true, noSkills:true, noPromptTemplates:true, noThemes:true, noContextFiles:true,
        additionalExtensionPaths:[resolve(process.env.PI_FFF_EXTENSION_PATH)] } })
    const loader = services.resourceLoader
    assert.equal(loader.getExtensions().errors.length, 0, JSON.stringify(loader.getExtensions().errors))
    assert.equal(loader.getExtensions().extensions.length, 1)
    const adaptedExtension = desktopExtension(loader.getExtensions().extensions[0])
    assert.notEqual(adaptedExtension, loader.getExtensions().extensions[0], 'real installed version is supported')
    services.resourceLoader = new Proxy(loader, { get(target, prop) {
      if (prop === 'getExtensions') return () => {
        const loaded = target.getExtensions()
        return { ...loaded, extensions:loaded.extensions.map(desktopExtension) }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const errors = []
    session = (await createAgentSessionFromServices({ services, sessionManager:SessionManager.inMemory(project) })).session
    const started = performance.now()
    await session.bindExtensions({ mode:'print', onError:error=>errors.push(error) })
    assert.equal(globalThis.__fffSdkPromiseGlobal, undefined, 'opening a session must not even import the native indexer')
    assert(session.getActiveToolNames().includes('ffgrep'), 'FFF tools are ready before the first prompt')
    console.log(`PASS: real FFF startup registered tools in ${Math.round(performance.now()-started)}ms without starting an index scan.`)
    const search = session.agent.state.tools.find(tool => tool.name === 'ffgrep')
    const result = await search.execute('startup-search', { pattern:'unique_startup_search_marker' }, new AbortController().signal)
    assert.match(JSON.stringify(result), /startup-fixture\.txt/)
    assert(globalThis.__fffSdkPromiseGlobal, 'first actual search initializes FFF on demand')
    await session.reload()
    assert(session.getActiveToolNames().includes('ffgrep'))
    const afterReload = session.agent.state.tools.find(tool => tool.name === 'ffgrep')
    assert.match(JSON.stringify(await afterReload.execute('reloaded-search', { pattern:'unique_startup_search_marker' }, new AbortController().signal)), /startup-fixture\.txt/)
    assert.deepEqual(errors, [])
    console.log('PASS: real native FFF content search still finds files on first use and after reload, with isolated databases and no model requests.')
  }
} finally {
  if (session) {
    await session.extensionRunner?.emit({ type:'session_shutdown', reason:'quit' })
    session.dispose()
  }
  await rm(temporary, { recursive:true, force:true, maxRetries:5, retryDelay:100 })
}
