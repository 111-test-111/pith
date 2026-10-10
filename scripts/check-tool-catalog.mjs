/**
 * Settings → Tools lists one row per callable tool NAME. Several extensions can
 * override the same built-in (`@ff-labs/pi-fff` in override mode registers
 * `grep`/`find`, and a pretty-printer may register them too), while the SDK's
 * registry keeps exactly one definition per name — so the catalog must not
 * concatenate every extension's map.
 *
 * Regression: two extensions declaring one name produced two rows with the same
 * `value`, which also made the beUI `Tabs` treat them as one entry (selecting
 * either made the other unreachable). The live session's definition must win,
 * a switched-off extension's remembered tools must never shadow a live one, and
 * a built-in must stay hidden while an extension answers for its name.
 *
 * Pure: synthetic loader/session tools, no SDK host, no Electron.
 */
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(repo, 'node_modules', '.cache', 'pith-tool-catalog')
try {
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const bundle = join(scratch, 'catalog.mjs')
  await build({
    entryPoints: [join(repo, 'src/main/pi/catalog.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: bundle
  })
  const { buildToolCatalog } = await import(bundle)

  const extension = (id, tools, sourceInfo = {}) => ({
    path: id,
    resolvedPath: id,
    hidden: false,
    sourceInfo: { path: id, source: `npm:${id}`, scope: 'user', origin: 'package', baseDir: dirname(id), ...sourceInfo },
    tools: new Map(
      [...tools].map((name) => [
        name,
        { definition: { description: `${id} ${name}`, parameters: { type: 'object' } }, sourceInfo: { path: id } }
      ])
    )
  })

  const live = (name, extensionId) => ({
    name,
    description: `${name} from ${extensionId}`,
    parameters: { type: 'object' },
    sourceInfo: { path: extensionId, source: `npm:${extensionId}`, scope: 'global', origin: 'package' }
  })

  const loader = (extensions) => ({
    getExtensions: () => ({ extensions, diagnostics: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] })
  })

  const catalogOf = (extensions, sessionTools, options = {}) =>
    buildToolCatalog(
      loader(extensions),
      sessionTools,
      options.activeToolNames ?? sessionTools.map((tool) => tool.name),
      options.disabledExtensions ?? new Set(),
      options.packages ?? new Map(),
      options.knownTools ?? new Map()
    )

  const names = (catalog) => catalog.tools.map((tool) => tool.name)
  const rows = (catalog, name) => catalog.tools.filter((tool) => tool.name === name)

  // --- Local entries use their own names, never the configuration root ------
  const agentDir = join(scratch, 'agent')
  const projectDir = join(scratch, 'project')
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, 'package.json'), JSON.stringify({ name: 'unrelated-project', version: '9.9.9' }))
  const local = (path, scope, baseDir, tools = []) => extension(path, tools, {
    source: 'auto', scope, origin: 'top-level', baseDir
  })
  const rtk = local(join(agentDir, 'extensions/rtk.ts'), 'user', agentDir)
  const formatter = local(join(agentDir, 'extensions/formatter.mjs'), 'user', agentDir, ['format_output'])
  const reviewer = local(join(agentDir, 'extensions/reviewer/index.ts'), 'user', agentDir)
  const guard = local(join(agentDir, 'extensions/guard/src/index.ts'), 'user', agentDir)
  const projectHook = local(join(projectDir, '.pi/extensions/project-hook.ts'), 'project', join(projectDir, '.pi'))
  const locals = catalogOf([rtk, formatter, reviewer, guard, projectHook], [live('format_output', formatter.path)])
  const localInfo = (entry) => locals.extensions.find((info) => info.id === entry.path)
  assert.equal(localInfo(rtk).name, 'rtk', 'an event-only user extension is named after its entry file')
  assert.deepEqual(localInfo(rtk).toolNames, [], 'event-only extensions remain visible without declaring tools')
  assert.equal(localInfo(formatter).name, 'formatter', 'extensions sharing one configuration root keep distinct names')
  assert.equal(rows(locals, 'format_output')[0].source.label, 'formatter', 'tool source labels use the same extension name')
  assert.equal(localInfo(reviewer).name, 'reviewer', 'directory index entries use the extension directory')
  assert.equal(localInfo(guard).name, 'guard', 'generic source directories do not become extension names')
  assert.equal(localInfo(projectHook).name, 'project-hook', 'a local extension does not inherit its enclosing project name')
  assert.equal(localInfo(projectHook).version, undefined, 'project package versions do not describe local extensions')

  const packageExtension = extension('/pkg/vendor-extension/src/index.ts', [])
  const packaged = catalogOf([packageExtension], [], {
    packages: new Map([[packageExtension.sourceInfo.source, { packageName: '@vendor/extension', version: '1.2.3', resources: [] }]])
  })
  assert.equal(packaged.extensions[0].name, '@vendor/extension', 'installed package metadata keeps precedence over entry names')
  assert.equal(packaged.extensions[0].version, '1.2.3')

  // --- Two extensions override the same two built-ins -----------------------
  const fff = extension('/pkg/pi-fff/src/index.ts', ['grep', 'find', 'multi_grep'])
  const pretty = extension('/pkg/pi-pretty/src/index.ts', ['read', 'bash', 'find', 'grep'])
  const overridden = catalogOf([fff, pretty], [
    live('read', pretty.path),
    live('edit', '<sdk:edit>'),
    // The session registry holds ONE definition per name; for `grep`/`find` the
    // last registering extension (pi-fff) won.
    live('grep', fff.path),
    live('find', fff.path),
    { name: 'bash', description: 'app bash', parameters: {}, sourceInfo: { path: '<builtin:bash>', source: 'builtin' } },
    { name: 'grep', description: 'builtin grep', parameters: {}, sourceInfo: { path: '<builtin:grep>', source: 'builtin' } },
    { name: 'find', description: 'builtin find', parameters: {}, sourceInfo: { path: '<builtin:find>', source: 'builtin' } }
  ])

  assert.deepEqual(
    names(overridden).filter((name) => name === 'grep' || name === 'find'),
    ['grep', 'find'],
    'an overridden built-in is listed once'
  )
  assert.equal(rows(overridden, 'grep')[0].source.extensionId, fff.path, 'the live definition owns the name')
  assert.equal(rows(overridden, 'find')[0].source.extensionId, fff.path)
  assert.equal(rows(overridden, 'read')[0].source.extensionId, pretty.path)
  assert.equal(rows(overridden, 'bash')[0].source.kind, 'builtin', 'the built-in stays for a name no extension answers for')
  assert.equal(new Set(names(overridden)).size, names(overridden).length, 'no name appears twice')
  assert.deepEqual(
    overridden.extensions.find((entry) => entry.id === fff.path).toolNames,
    ['grep', 'find', 'multi_grep'],
    'an extension still reports the tools it declares'
  )

  // --- A switched-off extension's snapshot cannot shadow a live tool --------
  const remembered = catalogOf([fff, pretty], [live('grep', pretty.path)], {
    disabledExtensions: new Set([fff.path]),
    knownTools: new Map([[fff.path, [{ name: 'grep', description: 'stale fff grep', parameters: {}, source: { kind: 'extension', extensionId: fff.path, label: 'pi-fff' }, active: false, disabledByExtension: true }]]])
  })
  assert.equal(rows(remembered, 'grep').length, 1, 'a remembered tool takes the name only when nothing is live')
  assert.equal(rows(remembered, 'grep')[0].source.extensionId, pretty.path)
  assert.equal(rows(remembered, 'grep')[0].active, true)

  // --- Nothing live for the name: the snapshot still shows (inactive) -------
  // The extension registers lazily (no static `extension.tools`), which is
  // exactly how pi-fff behaves: switching it off leaves only the snapshot.
  const lazy = extension('/pkg/lazy/src/index.ts', [])
  const retired = catalogOf([lazy], [{ name: 'ls', description: 'ls', parameters: {}, sourceInfo: { path: '<builtin:ls>', source: 'builtin' } }], {
    disabledExtensions: new Set([lazy.path]),
    knownTools: new Map([[lazy.path, [{ name: 'grep', description: 'fff grep', parameters: {}, source: { kind: 'extension', extensionId: lazy.path, label: 'pi-fff' }, active: false, disabledByExtension: true }]]])
  })
  assert.equal(rows(retired, 'grep').length, 1)
  assert.equal(rows(retired, 'grep')[0].disabledByExtension, true)
  assert.deepEqual(names(retired), ['grep', 'ls'])

  // --- Exposure is distinct from the model-facing active set --------------
  const nativeMcp = extension('/sdk/native-mcp.ts', [])
  const exposed = catalogOf([nativeMcp], [
    { ...live('mcp__beui__get_component', nativeMcp.path), exposure: 'codemode' },
    { ...live('mcp__context7__resolve_library_id', nativeMcp.path), exposure: 'deferred' },
    { ...live('mcp__hidden__secret', nativeMcp.path), exposure: 'hidden' }
  ], { activeToolNames: [] })
  assert.equal(rows(exposed, 'mcp__beui__get_component')[0].active, false, 'codemode MCP stays out of model declarations')
  assert.equal(rows(exposed, 'mcp__beui__get_component')[0].exposure, 'codemode', 'the callable exposure reaches the renderer')
  assert.equal(rows(exposed, 'mcp__context7__resolve_library_id')[0].exposure, 'deferred', 'on-demand exposure is preserved')
  assert.equal(rows(exposed, 'mcp__hidden__secret')[0].exposure, 'hidden', 'hidden exposure is preserved for an honest inactive badge')
  assert.equal(rows(overridden, 'grep')[0].exposure, 'direct', 'older extensions default to direct exposure')
  const native = catalogOf([], [
    { ...live('mcp__beui__get_component', '<inline:native-mcp>'), sourceInfo: { path: '<inline:native-mcp>', source: 'inline' }, exposure: 'codemode' },
    { ...live('codemode', '<inline:native-codemode>'), sourceInfo: { path: '<inline:native-codemode>', source: 'inline' }, exposure: 'model-only' },
    { ...live('tool_search', '<inline:native-tool-search>'), sourceInfo: { path: '<inline:native-tool-search>', source: 'inline' }, exposure: 'model-only' },
    { ...live('third_party', '<inline:other>'), sourceInfo: { path: '<inline:other>', source: 'inline' } }
  ])
  assert.deepEqual(native.tools.map(tool => [tool.name, tool.source.label]), [
    ['mcp__beui__get_component', 'Pi MCP'], ['codemode', 'codemode'],
    ['tool_search', 'tool_search'], ['third_party', 'inline']
  ], 'only the exact hidden SDK factories gain meaningful native source labels')

  console.log('PASS: the tool catalog names local extensions correctly, keeps one live row per tool and preserves callable exposure separately from model activity.')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
