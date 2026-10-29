/**
 * Subagent extension-tools end-to-end check: a profile that names an
 * extension tool must produce a child that can actually call it.
 *
 * Exercises the REAL chain with the real SDK (no stub loader):
 *   local extension registers `probe_tool` → the parent's getAllTools()
 *   attributes it by its origin tag ("local" — never a literal "extension")
 *   → `ceilingNeedsExtensions` fires on a ceiling naming it → a child built
 *   the way `buildSession` builds one (extensions loader + the ceiling as the
 *   create allowlist + `setActiveToolsByName`) registers AND activates the
 *   tool → a `noExtensions` child (the extension-free twin) does not.
 *
 * This pins the contract the checked-tools bug broke twice: first the blanket
 * `noExtensions` loader, then a predicate matching a `source` value the SDK
 * never stamps. Plain node, no Electron app, no model calls:
 *   node scripts/check-subagent-extension-tools.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'pith-subagent-ext-tools-'))
const workspace = join(temporary, 'workspace')
const agentDir = join(temporary, 'agent')
const sessionsDir = join(temporary, 'sessions')

try {
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(join(agentDir, 'extensions', 'probe'), { recursive: true }), mkdir(sessionsDir)])

  // A minimal local extension: registers one tool at session_start.
  await writeFile(
    join(agentDir, 'extensions', 'probe', 'index.js'),
    `export default function (pi) {
  pi.registerTool({
    name: 'probe_tool',
    label: 'Probe',
    description: 'Fixture extension tool',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      return { content: [{ type: 'text', text: 'probed' }] }
    }
  })
}
`,
    'utf8'
  )

  const bundle = join(temporary, 'modules.mjs')
  await build({
    stdin: {
      contents: `export { ceilingNeedsExtensions } from './src/main/pi/subagents/runtime';`,
      resolveDir: repo
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundle,
    plugins: [
      {
        name: 'isolated',
        setup(builder) {
          builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
            path: fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')),
            external: true
          }))
          builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `export const app={getPath(){return ${JSON.stringify(temporary)}}}; export const shell={};`
          }))
        }
      }
    ]
  })
  const { ceilingNeedsExtensions } = await import(pathToFileURL(bundle))
  const { ModelRuntime, SessionManager, createAgentSessionFromServices, createAgentSessionServices } = await import(
    '@earendil-works/pi-coding-agent'
  )

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir

  // Provider I/O is never touched: the model runtime is stubbed like every
  // other real-SDK check in this repo.
  const modelRuntime = await ModelRuntime.create({
    authPath: join(temporary, 'auth.json'),
    modelsPath: join(temporary, 'models.json'),
    modelsStorePath: join(temporary, 'models-store'),
    refreshOnCreate: false
  })
  modelRuntime.hasConfiguredAuth = () => true
  modelRuntime.checkAuth = () => {
    throw Error('Unexpected auth access')
  }
  const model = {
    id: 'fixture', name: 'fixture', provider: 'fixture', api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096
  }
  modelRuntime.getAvailableSnapshot = () => [model]

  const materialize = async (manager) => {
    await writeFile(manager.getSessionFile(), `${JSON.stringify(manager.getHeader())}\n`)
    manager.setSessionFile(manager.getSessionFile())
  }
  const services = (noExtensions) =>
    createAgentSessionServices({
      cwd: workspace,
      modelRuntime,
      resourceLoaderOptions: { noExtensions, extensionFactories: [] }
    })

  const sessions = []
  try {
    // 1. The parent: extensions on (a normal session), the probe tool
    //    registers with its ORIGIN TAG as source — the attribution the
    //    dispatch decision reads.
    const parentManager = SessionManager.create(workspace, sessionsDir)
    await materialize(parentManager)
    const { session: parent } = await createAgentSessionFromServices({ services: await services(false), sessionManager: parentManager })
    sessions.push(parent)
    await parent.bindExtensions({ mode: 'print', onError: (error) => console.error(error) })
    const parentTools = parent.getAllTools()
    const probe = parentTools.find((tool) => tool.name === 'probe_tool')
    assert.ok(probe, 'the local extension registers probe_tool in a normal session')
    // The exact tag varies by discovery route ("local", "auto", "temporary",
    // "npm:…") — the invariant the dispatch decision relies on is that it is
    // NEITHER of the SDK's two synthetic non-extension sources.
    assert.ok(
      probe.sourceInfo.source !== 'builtin' && probe.sourceInfo.source !== 'sdk',
      `an extension tool carries its origin tag (${JSON.stringify(probe.sourceInfo.source)}), never "builtin"/"sdk"`
    )

    // 2. The dispatch decision over the REAL attribution (no fixtures).
    assert.equal(ceilingNeedsExtensions(['read', 'probe_tool'], parentTools), true, 'a ceiling naming the extension tool fires the flag')
    assert.equal(ceilingNeedsExtensions(['read', 'grep'], parentTools), false, 'a built-in-only ceiling stays extension-free')

    // 3. The child, built exactly the way buildSession builds one: extensions
    //    loader, the ceiling as the create allowlist, then the active clamp.
    const childCeiling = ['read', 'probe_tool']
    const childManager = SessionManager.create(workspace, sessionsDir, { parentSession: parentManager.getSessionFile() })
    await materialize(childManager)
    const { session: child } = await createAgentSessionFromServices({
      services: await services(false),
      sessionManager: childManager,
      tools: childCeiling
    })
    sessions.push(child)
    await child.bindExtensions({ mode: 'print', onError: (error) => console.error(error) })
    child.setActiveToolsByName([...childCeiling])
    assert.ok(child.getAllTools().some((tool) => tool.name === 'probe_tool'), 'the extension child registers the ceiling-named extension tool')
    assert.ok(child.getActiveToolNames().includes('probe_tool'), 'the ceiling allowlist admits it and the active clamp turns it on')

    // 4. The extension-free twin: same ceiling, noExtensions loader — the
    //    tool has no definition there (the original bug's shape).
    const plainManager = SessionManager.create(workspace, sessionsDir, { parentSession: parentManager.getSessionFile() })
    await materialize(plainManager)
    const { session: plain } = await createAgentSessionFromServices({
      services: await services(true),
      sessionManager: plainManager,
      tools: childCeiling
    })
    sessions.push(plain)
    await plain.bindExtensions({ mode: 'print', onError: (error) => console.error(error) })
    plain.setActiveToolsByName([...childCeiling])
    assert.equal(plain.getAllTools().some((tool) => tool.name === 'probe_tool'), false, 'an extension-free child has no definition for it')
    assert.deepEqual(plain.getActiveToolNames().sort(), ['read'], 'its active set is the built-in remainder of the ceiling')
  } finally {
    for (const session of sessions) {
      try {
        await session[Symbol.asyncDispose]?.()
      } catch {}
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  }

  console.log('PASS: subagent extension tools — origin-tag attribution fires, the extensions child registers+activates the tool, the free twin does not')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
