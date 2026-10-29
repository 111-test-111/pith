/** Real-model E2E for subagent reuse + communications (Settings → Subagents).
 *
 * Launches the BUILT app with an isolated HOME (provider credentials/config
 * are copied; profiles, sessions and userData are fresh), enables
 * subagentReuseEnabled/subagentCommsEnabled up front, then drives ONE parent
 * prompt through the whole feature set with a real provider:
 *
 *   background agent dispatch → agent_steer while running → child
 *   message_parent mid-run → subagent_completion notice → continue_session_id
 *   foreground continuation.
 *
 * Assertions read BOTH the live DOM (notice rows, child-pane bubble) and the
 * session files on disk (steered user message, message_parent call, two run
 * records). Real model calls use the configured provider and incur its normal
 * charges. Not part of CI — run on demand:
 *   node scripts/check-subagent-e2e.mjs
 *
 * PI_SUBAGENT_E2E_SCREENSHOT_DIR retains screenshots. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { chmod, copyFile, cp, mkdtemp, readFile, stat, symlink, writeFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const DEBUG_PORT = 9533
const shots = process.env.PI_SUBAGENT_E2E_SCREENSHOT_DIR
const MARKER_HALFWAY = 'probe-halfway'
const MARKER_STEER = 'steer-probe'
const MARKER_DONE = 'E2E-PARENT-DONE'

/** The one prompt that drives everything. Explicit and narrow so any
 * provider follows it deterministically. */
const PROMPT = `You are running an E2E test of subagent features. Perform EXACTLY these steps, in order, nothing else:

1. Call the agent tool with subagent_type="explore", run_in_background=true, description="E2E probe", and this prompt for the child: "E2E child task: list and read every file in the workspace root. Then, BEFORE you finish, call the message_parent tool exactly once with the message '${MARKER_HALFWAY}'. Then end with a one-line summary of the files you saw."

2. Immediately after the dispatch returns its receipt, call agent_steer once, with the session_id from that receipt and the message "${MARKER_STEER}: acknowledged - continue and finish".

3. End your turn and wait; the subagent_completion message will arrive as a new steering message.

4. When it has arrived, call the agent tool again with subagent_type="explore", continue_session_id set to that subagent's session id, run_in_background=false, description="E2E continue", and prompt "Reply with exactly: second-run-ok".

5. Finally reply with a single line: ${MARKER_DONE}`

let child, ws, temporary
let wsId = 0
const pending = new Map()

function send(method, params = {}) {
  const id = ++wsId
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 15_000)
    pending.set(id, { resolvePromise, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(result.exceptionDetails).slice(0, 400))
  return result.result.value
}

async function waitFor(expression, label, timeout = 20_000) {
  const deadline = Date.now() + timeout
  do {
    if (await evaluate(`Boolean(${expression})`)) return
    await pause(80)
  } while (Date.now() < deadline)
  throw new Error('timed out waiting for ' + label)
}

async function screenshot(name) {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(shots, `${name}.png`), Buffer.from(shot.data, 'base64'))
}

/** Newest session files under the isolated agent dir matching a predicate on
 * their raw text (bounded: only .jsonl files, newest first). */
function findSessionFiles(agentDir, predicate) {
  const root = join(agentDir, 'sessions')
  if (!existsSync(root)) return []
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  walk(root)
  return files
    .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .filter(({ file }) => {
      try { return predicate(readFileSync(file, 'utf8')) } catch { return false }
    })
    .map(({ file }) => file)
}

try {
  // Keep configured provider access without sharing writable settings,
  // credential refreshes, profiles, extensions or session directories.
  temporary = await mkdtemp(join(tmpdir(), 'pith-subagent-e2e-'))
  const configuredAgent = process.env.PI_CODING_AGENT_DIR
  const realAgent = configuredAgent
    ? configuredAgent.startsWith('~/') ? join(homedir(), configuredAgent.slice(2)) : resolve(configuredAgent)
    : join(homedir(), '.pi', 'agent')
  assert.ok(existsSync(realAgent), 'no configured Pi agent directory — run the app once first')
  const home = join(temporary, 'home')
  const agentDir = join(home, '.pi', 'agent')
  mkdirSync(agentDir, { recursive: true })
  for (const entry of ['auth.json', 'models.json']) {
    if (!existsSync(join(realAgent, entry))) continue
    await copyFile(join(realAgent, entry), join(agentDir, entry))
    await chmod(join(agentDir, entry), 0o600)
  }
  const settingsPath = join(realAgent, 'settings.json')
  const settings = existsSync(settingsPath) ? JSON.parse(await readFile(settingsPath, 'utf8')) : {}
  for (const resource of ['packages', 'extensions', 'skills', 'prompts', 'themes']) settings[resource] = []
  delete settings.sessionDir
  settings.cacheWarming = 'off'
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify(settings), { mode: 0o600 })
  mkdirSync(join(agentDir, 'sessions'))
  const workspace = join(temporary, 'workspace')
  mkdirSync(workspace, { recursive: true })
  await writeFile(join(workspace, 'alpha.md'), '# Alpha\nThe first file for the probe.\n')
  await writeFile(join(workspace, 'beta.json'), JSON.stringify({ kind: 'beta', items: 3 }, null, 2))
  await writeFile(join(workspace, 'gamma.txt'), 'gamma: plain text file\n')

  // ---- app tree: a copy of out/ plus the icon resources the dev icon root
  // needs (electron-builder ships them only when packaged) and a patched
  // userData root — the instance cannot see the user's real profile, and a
  // concurrent dev rebuild of out/ cannot pull the tree from under us. ----
  await stat(join(repo, 'out', 'renderer', 'index.html')).catch(() => {
    throw new Error('out/renderer/index.html is missing — run `npm run build` immediately before this check')
  })
  const appTree = join(temporary, 'app')
  await cp(join(repo, 'out'), appTree, { recursive: true })
  await cp(join(repo, 'resources'), join(appTree, 'main', 'resources'), { recursive: true })
  await symlink(join(repo, 'node_modules'), join(temporary, 'node_modules'))
  const userData = join(temporary, 'profile')
  mkdirSync(userData, { recursive: true })
  await writeFile(join(userData, 'app-settings.json'), JSON.stringify({
    cwd: workspace,
    folders: [workspace],
    startup: 'new',
    contextFiles: false,
    subagentsEnabled: true,
    subagentReuseEnabled: true,
    subagentCommsEnabled: true
  }, null, 2))
  const mainEntry = join(appTree, 'main', 'index.mjs')
  const original = await readFile(mainEntry, 'utf8')
  const NEEDLE = 'join(app.getPath("appData"), "pi-app")'
  assert.equal(
    original.split(NEEDLE).length - 1, 1,
    'expected exactly one userData-rooting expression in the built main entry — update this check'
  )
  await writeFile(mainEntry, original.replace(NEEDLE, JSON.stringify(userData)))

  // ---- launch ----
  const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PITH_CDP_PORT: String(DEBUG_PORT) }
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [mainEntry], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env
  })
  let output = ''
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error('no DevTools endpoint: ' + output)), 20000)
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)) })
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (match) { clearTimeout(timer); resolveEndpoint(match[1].replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '')) }
    })
  })
  let page
  for (let i = 0; i < 200 && !page; i++) {
    const list = await fetch(`${endpoint}/json/list`).then((r) => r.json()).catch(() => [])
    page = list.find((p) => p.type === 'page' && !/devtools/.test(p.url))
    if (!page) await pause(100)
  }
  assert.ok(page, 'renderer page found')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolveOpen, reject) => { ws.onopen = resolveOpen; ws.onerror = reject })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolvePromise, reject, timer } = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(timer)
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolvePromise(message.result)
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')

  // ---- boot: workspace ready, and isolation actually held ----
  let booted = null
  for (let i = 0; i < 150 && !booted; i++) {
    booted = await evaluate(`(function(){
      if (!window.pi || !document.querySelector('[data-prompt-editor]')) return null
      return window.pi.appInfo().then ? true : true
    })()`).catch(() => null)
    if (!booted) await pause(200)
  }
  assert.ok(booted, 'the app booted to the composer')
  const info = await evaluate(`window.pi.appInfo()`)
  assert.equal(info.cwd, workspace, `isolation check: cwd is the temp workspace (got ${info.cwd})`)
  assert.equal(info.subagentsEnabled, true, 'subagents enabled')
  assert.equal(info.subagentReuseEnabled, true, 'reuse enabled')
  assert.equal(info.subagentCommsEnabled, true, 'communications enabled')
  const profiles = await evaluate('window.pi.subagentProfiles()')
  assert.ok(profiles.profiles.some(profile => profile.name === 'explore' && profile.enabled), 'the isolated default explore profile is available')
  console.log('[boot] isolated app ready, cwd =', info.cwd)

  // ---- send the one driving prompt ----
  await evaluate(`window.__e2eParentPath=null;window.pi.onEvent(event=>{if(!window.__e2eParentPath&&!event.subagentChild&&event.cwd===${JSON.stringify(workspace)}&&event.sessionPath)window.__e2eParentPath=event.sessionPath})`)
  const accepted = await evaluate(`window.pi.prompt(${JSON.stringify({ text: PROMPT, images: [], files: [] })})`)
  assert.equal(accepted.accepted, true, 'prompt accepted')

  // ---- poll until the parent's FINAL ASSISTANT reply carries the done
  // marker (the user bubble also contains it, so the transcript text alone
  // would fire immediately) and the session is no longer streaming ----
  const probe = () => evaluate(`(async function(){
    const sessions = await window.pi.listSessions()
    const own = sessions.filter((s) => s.cwd === ${JSON.stringify(workspace)})
    const row = own.find((s) => (s.label || '').includes('E2E')) ?? own[0] ?? null
    const snap = { parentPath: window.__e2eParentPath ?? row?.path ?? null }
    const text = document.body.textContent || ''
    snap.messageRows = [...document.querySelectorAll('[data-subagent-message]')].map((n) => n.textContent)
    snap.completionRows = document.querySelectorAll('[data-subagent-completion]').length
    snap.sawSteerTool = text.includes('agent_steer')
    if (snap.parentPath) {
      const peek = await window.pi.peekSession(snap.parentPath)
      snap.busy = peek.isStreaming
      snap.done = (peek.messages || []).some((m) => m.role === 'assistant' && JSON.stringify(m.content || []).includes(${JSON.stringify(MARKER_DONE)}))
    }
    return snap
  })()`)
  let snap
  const deadline = Date.now() + 8 * 60_000
  let last = ''
  for (;;) {
    snap = await probe().catch(() => null)
    const key = JSON.stringify(snap)
    if (key !== last) { console.log('[poll]', key); last = key }
    if (snap && snap.done && snap.busy === false) break
    if (Date.now() > deadline) throw new Error('timed out waiting for the parent to finish: ' + key)
    await pause(3000)
  }
  // ---- roster + child pane (the steer must read as a user bubble there) ----
  const runs = await evaluate(`window.pi.listSubagents(${JSON.stringify(snap.parentPath)})`)
  assert.equal(runs.length, 1, 'one child session on the roster')
  const run = runs[0]
  assert.equal(run.status, 'completed', 'the continued (latest) run completed')
  assert.equal(run.profile, 'explore')
  console.log('[roster]', JSON.stringify({ sessionId: run.sessionId, status: run.status, tokens: run.tokens, toolUses: run.toolUses }))

  // Settled process folds retain their notice headers, while each quiet
  // message row mounts its body only when opened. Read through those public
  // disclosures rather than treating a collapsed title as the message text.
  const messageSelector = `[data-subagent-message=${JSON.stringify(run.sessionId)}]`
  await waitFor(`document.querySelector(${JSON.stringify(messageSelector)})`, 'the child message notice')
  await evaluate(`(()=>{
    const row=document.querySelector(${JSON.stringify(messageSelector)});
    const process=row.closest('[data-turn-process]');
    const body=process?.parentElement;
    if(body?.getAttribute('aria-hidden')==='true'){
      const trigger=body.previousElementSibling?.querySelector('button[aria-expanded="false"]');
      if(!trigger)throw new Error('the settled process has no disclosure trigger');
      trigger.click();
    }
  })()`)
  await waitFor(`!document.querySelector(${JSON.stringify(messageSelector)}).closest('[aria-hidden="true"],[inert]')`, 'the process disclosure opened')
  await evaluate(`document.querySelector(${JSON.stringify(messageSelector)}).querySelector('button[aria-expanded="false"]')?.click()`)
  await waitFor(`(()=>{const row=document.querySelector(${JSON.stringify(messageSelector)});return row.querySelector('button[aria-expanded="true"]')&&row.innerText.includes(${JSON.stringify(MARKER_HALFWAY)})})()`, 'the expanded child message text')
  snap = await probe()
  await screenshot('parent-done')

  await waitFor('document.querySelector(\'[data-task-trigger="agents"]\')', 'the subagents task-strip trigger')
  await evaluate(`(()=>{const trigger=document.querySelector('[data-task-trigger="agents"]');if(trigger.getAttribute('aria-expanded')!=='true')trigger.click()})()`)
  const openSelector = `[data-task-panel="agents"] [data-subagent-open=${JSON.stringify(run.sessionId)}]`
  await waitFor(`(()=>{const link=document.querySelector(${JSON.stringify(openSelector)});return link&&!link.closest('[aria-hidden="true"],[inert]')&&link.getBoundingClientRect().height>0})()`, 'the child-session link in the open roster')
  const opened = await evaluate(`(function(){
    const link = document.querySelector(${JSON.stringify(openSelector)})
    if (!link) return false
    link.click()
    return true
  })()`)
  assert.equal(opened, true, 'the roster offers an open-session link')
  const paneSelector = `[data-subagent-pane=${JSON.stringify(run.sessionPath)}]`
  await waitFor(`(()=>{const host=document.querySelector(${JSON.stringify(paneSelector)});return host&&[...host.querySelectorAll('[data-user-bubble-body]')].some(node=>node.innerText.includes(${JSON.stringify(MARKER_STEER)}))})()`, 'the actual child pane shows its steered user message')
  const pane = await evaluate(`(function(){
    const host = document.querySelector(${JSON.stringify(paneSelector)})
    return { hasSteerBubble: !!host&&[...host.querySelectorAll('[data-user-bubble-body]')].some(node=>node.innerText.includes(${JSON.stringify(MARKER_STEER)})) }
  })()`)
  await screenshot('child-pane')
  console.log('[pane]', JSON.stringify(pane))

  // ---- disk truth: parent + child session files ----
  const parentFile = snap.parentPath
  for (const file of [parentFile, run.sessionPath]) {
    const path = relative(join(agentDir, 'sessions'), file)
    assert.ok(path && !path.startsWith('..') && !isAbsolute(path), 'session files remain in the isolated agent directory')
  }
  const parentText = readFileSync(parentFile, 'utf8')
  // Only CHILD files carry run records (the parent writes dispatch entries,
  // a different custom type), so this predicate cannot match the parent.
  const childFiles = findSessionFiles(agentDir, (text) => text.includes('"pith_subagent_run"') && text.includes(run.sessionId))
  assert.equal(childFiles.length, 1, `exactly one child session file (got ${childFiles.length})`)
  const childText = readFileSync(childFiles[0], 'utf8')

  // Parent-side assertions.
  assert.ok(parentText.includes('"subagent_message"'), 'the parent file persists the subagent_message notice')
  assert.ok(parentText.includes(MARKER_HALFWAY), 'the child message text reached the parent session')
  assert.ok(parentText.includes('"subagent_completion"'), 'the background completion notice persisted')
  assert.ok(parentText.includes('"agent_steer"'), 'the parent made an agent_steer call')
  assert.equal((parentText.match(/"pith_subagent_dispatch"/g) || []).length, 2, 'two dispatch records (initial + continuation)')

  // Child-side assertions.
  assert.ok(childText.includes('"parentSession"'), 'the child header links its parent')
  assert.ok(childText.includes(MARKER_STEER), 'the steer LANDED in the child session (a user message)')
  assert.ok(childText.includes('"message_parent"'), 'the child called message_parent')
  assert.equal((childText.match(/"pith_subagent_run"/g) || []).length, 2, 'two run records: initial dispatch + continuation')
  assert.equal((childText.match(/"pith_subagent_result"/g) || []).length, 2, 'both runs carry terminal records')

  // Renderer notice rows.
  assert.equal(snap.completionRows >= 1, true, 'a completion notice row rendered in the transcript')
  assert.ok(snap.messageRows.some((row) => row.includes(MARKER_HALFWAY)), 'the child message rendered as a quiet tool row')
  assert.equal(pane.hasSteerBubble, true, 'the steer reads as a message bubble in the child pane')

  console.log('PASS: subagent E2E — background dispatch, agent_steer, message_parent notice, completion, continue_session_id')
} finally {
  try { ws?.close() } catch { /* already closed */ }
  for (const entry of pending.values()) clearTimeout(entry.timer)
  const alive = () => child && child.exitCode === null && child.signalCode === null
  const exited = () => new Promise(resolveExit => {
    if (!alive()) { resolveExit(); return }
    child.once('exit', resolveExit)
  })
  if (alive()) {
    child.kill('SIGTERM')
    await Promise.race([exited(), pause(4000)])
    if (alive()) {
      child.kill('SIGKILL')
      await Promise.race([exited(), pause(3000)])
    }
  }
  assert.ok(!alive(), 'the isolated Electron instance exited before fixture cleanup')
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
