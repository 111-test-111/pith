/**
 * DSH file sandbox, exercised against the real host runner (Seatbelt on macOS,
 * bubblewrap/Landlock on Linux). No model calls, no user data.
 *
 * The point of this check is that it is not a mock: it runs the actual
 * `sandbox-exec` wrapper pi-app spawns for bash, and asserts what the kernel
 * allowed. When no runner exists on the host (or the platform is unsupported)
 * the check asserts the fail-closed path instead of skipping silently.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temporary = await mkdtemp(join(tmpdir(), 'pith-sandbox-check-'))
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const outfile = join(temporary, 'modules.mjs')
await build({
  stdin: {
    contents: `export { BashTaskManager } from './src/main/bash/manager';
export { confineShellArgv, sandboxDenied, sandboxPolicyFor, sandboxStatus, scrubbedParentEnv, runnerFailureMessage } from './src/main/sandbox/broker';
export { buildSandboxPolicy, writableRoots } from './src/main/sandbox/policy';
export { resolveSandboxPath, isSandboxPathWithin } from './src/main/sandbox/paths';
export { sandboxModeFromBranch, SANDBOX_MODE_ENTRY_TYPE } from './src/main/sandbox/mode';
export { createSandboxFileTools } from './src/main/pi/file-tools';
export { createManagedBashTools } from './src/main/pi/bash-tools';
export { listPendingEscalations, respondToEscalation } from './src/main/sandbox/pending';
export { resolveEscalatedMode } from './src/main/sandbox/escalation';
export { localSandboxProvider, resetLocalSandboxProvider } from './src/main/sandbox/local';
export { SandboxUnavailableError } from './src/main/sandbox/types';`,
    resolveDir: resolve('.')
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  // The SDK stays external: its own sources are not ours to bundle, and the
  // file tools are only exercised through the seams they expose.
  plugins: [{
    name: 'sdk-external',
    setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
        path: fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), external: true
      }))
    }
  }]
})

const sandbox = await import(pathToFileURL(outfile).href)
const {
  BashTaskManager,
  confineShellArgv,
  sandboxDenied,
  sandboxPolicyFor,
  sandboxStatus,
  scrubbedParentEnv,
  runnerFailureMessage,
  buildSandboxPolicy,
  writableRoots,
  resolveSandboxPath,
  isSandboxPathWithin,
  localSandboxProvider,
  resetLocalSandboxProvider,
  SandboxUnavailableError,
  sandboxModeFromBranch,
  SANDBOX_MODE_ENTRY_TYPE,
  createSandboxFileTools,
  createManagedBashTools,
  listPendingEscalations,
  respondToEscalation,
  resolveEscalatedMode
} = sandbox

const workspace = join(temporary, 'workspace')
await mkdir(workspace, { recursive: true })
const canonicalWorkspace = await realpath(workspace)

// ---------------------------------------------------------------- path policy
{
  // A symlink that points outside must resolve outside — that is the whole
  // reason the resolver canonicalizes the deepest existing ancestor.
  const outside = join(temporary, 'outside')
  await mkdir(outside, { recursive: true })
  await symlink(outside, join(workspace, 'escape'))

  const viaSymlink = resolveSandboxPath(join(workspace, 'escape', 'new.txt'), {
    cwd: canonicalWorkspace,
    homeDir: homedir()
  })
  assert.equal(viaSymlink, join(await realpath(outside), 'new.txt'), 'symlink escape resolves to its real target')
  assert.equal(isSandboxPathWithin(viaSymlink, canonicalWorkspace), false, 'symlink escape is outside the workspace')

  // `..` cannot walk out of the root either.
  const dotdot = resolveSandboxPath(join(workspace, '..', 'outside', 'x.txt'), {
    cwd: canonicalWorkspace,
    homeDir: homedir()
  })
  assert.equal(isSandboxPathWithin(dotdot, canonicalWorkspace), false, '.. cannot escape the workspace')

  // A leaf that does not exist yet still resolves inside, because the check
  // runs before the file is created.
  const fresh = resolveSandboxPath(join(workspace, 'deep', 'deeper', 'new.txt'), {
    cwd: canonicalWorkspace,
    homeDir: homedir()
  })
  assert.equal(fresh, join(canonicalWorkspace, 'deep', 'deeper', 'new.txt'), 'a new file resolves under its existing ancestor')
  assert.equal(isSandboxPathWithin(fresh, canonicalWorkspace), true, 'a new file inside the workspace is allowed by containment')

  const roots = writableRoots(buildSandboxPolicy('workspace-write', canonicalWorkspace))
  assert.ok(roots.includes(canonicalWorkspace), 'workspace-write includes the workspace root')
  assert.ok(roots.includes(await realpath(tmpdir())), 'workspace-write includes the host temp root')
  assert.deepEqual(writableRoots(buildSandboxPolicy('read-only', canonicalWorkspace)), [], 'read-only grants no writable root')

  // Segment-aware: a sibling directory sharing a name prefix is not inside.
  assert.equal(isSandboxPathWithin(`${canonicalWorkspace}-other/file`, canonicalWorkspace), false, 'prefix siblings are outside')
}

// ------------------------------------------------------------ environment scrub
{
  const scrubbed = scrubbedParentEnv({
    PATH: '/usr/bin',
    MY_API_KEY: 'secret',
    DB_PASSWORD: 'secret',
    SESSION_TOKEN: 'secret',
    DSH_INTERNAL: 'secret',
    HOME: '/Users/example'
  })
  assert.equal(scrubbed.PATH, '/usr/bin', 'PATH survives the scrub')
  assert.equal(scrubbed.HOME, '/Users/example', 'HOME survives (reads are unrestricted)')
  for (const name of ['MY_API_KEY', 'DB_PASSWORD', 'SESSION_TOKEN', 'DSH_INTERNAL']) {
    assert.equal(name in scrubbed, false, `${name} is removed from a confined command's environment`)
  }
}

// ----------------------------------------------------------------- exit reading
{
  const confined = { denialSignatures: ['operation not permitted'] }
  assert.equal(sandboxDenied(1, 'bash: x: Operation not permitted', confined), true, 'a denial is recognised')
  assert.equal(sandboxDenied(0, '', confined), false, 'a clean exit is never a denial')
  const rules = [{ fatalSignatures: ['sandbox-exec: '], allowedExitCodes: [125] }]
  assert.equal(runnerFailureMessage(125, 'sandbox-exec: bogus profile', rules), 'sandbox-exec: bogus profile', 'a broken runner is not a denial')
  assert.equal(runnerFailureMessage(0, 'sandbox-exec: x', rules), null, 'a clean exit has no runner failure')
}

// ------------------------------------------------------- per-session mode fold
{
  const entry = (mode) => ({ type: 'custom', customType: SANDBOX_MODE_ENTRY_TYPE, data: { mode } })
  const foreign = { type: 'custom', customType: 'something_else', data: { mode: 'read-only' } }

  assert.equal(sandboxModeFromBranch([], 'workspace-write'), 'workspace-write', 'a branch with no entry falls back to the default')
  assert.equal(sandboxModeFromBranch([entry('read-only')]), 'read-only', 'a recorded mode is read back')
  // The newest entry wins, so a second switch is what stays in force, and
  // reopening the session restores exactly that.
  assert.equal(sandboxModeFromBranch([entry('read-only'), entry('danger-full-access')]), 'danger-full-access', 'the newest entry wins')
  assert.equal(sandboxModeFromBranch([entry('danger-full-access'), foreign]), 'danger-full-access', 'another feature\'s entries are ignored')
  assert.equal(sandboxModeFromBranch([{ type: 'message' }], 'read-only'), 'read-only', 'a branch without our entries keeps the fallback')
}

// ------------------------------------------ the switch reaches the next call
{
  // The tools must read the mode per call rather than once at build: that is
  // what makes a switch apply to the very next tool call, a steered turn
  // included.
  const cwd = join(temporary, 'live-mode')
  await mkdir(cwd, { recursive: true })
  const target = join(cwd, 'inside.txt')
  await writeFile(target, 'hello\nworld\n', 'utf8')

  let mode = 'read-only'
  const [edit] = createSandboxFileTools({ cwd, getMode: () => mode })
  const context = { cwd }
  const call = () => edit.execute('call', { path: target, edits: [{ oldText: 'world', newText: 'there' }] }, undefined, undefined, context)

  await assert.rejects(call, /denied/i, 'read-only refuses the edit')
  assert.match(await readFile(target, 'utf8'), /world/, 'the refused edit changed nothing')

  mode = 'workspace-write'
  await call()
  assert.match(await readFile(target, 'utf8'), /there/, 'the same tool instance applies the newly switched mode on its next call')
}

// ------------------------------------------------------- Plan denial wording
{
  const cwd = join(temporary, 'plan-wording')
  await mkdir(cwd, { recursive: true })
  const target = join(cwd, 'file.txt')
  await writeFile(target, 'one\ntwo\n', 'utf8')

  // Plan denies without ever offering a wider mode: the model must not be told
  // to escalate or to change a setting.
  const [planEdit] = createSandboxFileTools({ cwd, getMode: () => 'read-only', isPlanRestricted: () => true })
  await assert.rejects(
    () => planEdit.execute('plan-call', { path: target, edits: [{ oldText: 'one', newText: 'edited' }] }, undefined, undefined, { cwd }),
    (error) => {
      assert.match(String(error.message), /\[plan:/i, 'a Plan denial must name Plan')
      assert.match(String(error.message), /file access denied/i, 'a Plan denial must still explain the policy')
      assert.equal(/escalation available/i.test(String(error.message)), false, 'Plan offered the escalation lever')
      assert.equal(/change the mode|full access|settings/i.test(String(error.message)), false, 'Plan suggested changing the sandbox')
      return true
    },
    'a Plan file denial was not Plan-specific'
  )
  assert.match(await readFile(target, 'utf8'), /one/, 'the Plan denial changed the file')

  // Ordinary mode keeps its existing denial text — no Plan marker leaks in.
  const [ordinaryEdit] = createSandboxFileTools({ cwd, getMode: () => 'read-only' })
  await assert.rejects(
    () => ordinaryEdit.execute('ordinary-call', { path: target, edits: [{ oldText: 'one', newText: 'edited' }] }, undefined, undefined, { cwd }),
    (error) => {
      assert.match(String(error.message), /SANDBOX_FILE_DENIED/i, 'ordinary wording changed')
      assert.equal(/\[plan:/i.test(String(error.message)), false, 'ordinary mode leaked a Plan marker')
      return true
    },
    'the ordinary denial changed'
  )
}

// --------------------------------------------------------- one-shot escalation
{
  const cwd = join(temporary, 'escalation')
  await mkdir(cwd, { recursive: true })
  const inside = join(cwd, 'file.txt')
  await writeFile(inside, 'one\ntwo\n', 'utf8')
  const outside = join(await realpath(tmpdir()), 'pith-escalation-outside.txt')
  await writeFile(outside, 'one\ntwo\n', 'utf8')

  // The session's mode never moves: only the answered call runs wider.
  let mode = 'read-only'
  const sessionPath = 'escalation.jsonl'
  const tools = createSandboxFileTools({
    cwd,
    getMode: () => mode,
    escalate: (input) =>
      resolveEscalatedMode({
        sessionId: 'escalation',
        sessionPath,
        currentMode: mode,
        onChanged: () => {},
        ...input
      })
  })
  const [edit] = tools
  const context = { cwd }
  const ask = (path, sandboxPermissions, justification = 'needs to touch this file') =>
    edit.execute(
      'call',
      { path, edits: [{ oldText: 'one', newText: 'edited' }], sandbox_permissions: sandboxPermissions, justification },
      undefined,
      undefined,
      context
    )

  // 1. Approving runs exactly this call wider — and leaves the session's mode
  //    alone, which is what makes the next call narrow again.
  const approving = ask(outside, 'danger-full-access').then(() => 'ok', (error) => error)
  await delay(30)
  const queued = listPendingEscalations(sessionPath)
  assert.equal(queued.length, 1, 'the call registered exactly one question')
  assert.equal(queued[0].requestedMode, 'danger-full-access', 'the question names the requested mode')
  assert.equal(queued[0].currentMode, 'read-only', 'the question names the mode it is wider than')
  assert.equal(queued[0].toolName, 'edit', 'the question names the tool asking')
  assert.deepEqual(queued[0].operation, {
    cwd,
    parameters: { path: outside, edits: [{ oldText: 'one', newText: 'edited' }], sandbox_permissions: 'danger-full-access', justification: 'needs to touch this file' }
  }, 'approval carries the complete edit and execution directory')
  assert.equal(respondToEscalation(queued[0].requestId, sessionPath, 'approve'), true, 'the question is answered')
  assert.equal(await approving, 'ok', 'the approved call ran')
  assert.match(await readFile(outside, 'utf8'), /edited/, 'the approved call wrote the file')
  assert.equal(mode, 'read-only', 'approving one call did not change the session mode')
  assert.deepEqual(listPendingEscalations(sessionPath), [], 'an answered question leaves the queue')
  assert.equal(
    await ask(outside, undefined).then(() => 'ok', () => 'denied'),
    'denied',
    'the next call is narrow again — escalation was for one call'
  )

  // 2. Denying fails the call and writes nothing.
  await writeFile(inside, 'one\ntwo\n', 'utf8')
  const rejecting = ask(inside, 'danger-full-access').then(() => 'ok', (error) => error)
  await delay(30)
  const [denied] = listPendingEscalations(sessionPath)
  assert.ok(denied, 'the second call registered its question')
  respondToEscalation(denied.requestId, sessionPath, 'deny')
  const rejection = await rejecting
  assert.match(String(rejection?.message ?? rejection), /rejected/, 'a denied escalation fails the call')
  assert.match(await readFile(inside, 'utf8'), /one\ntwo/, 'nothing was written')

  // 3. A cancelled question (the turn was aborted) fails closed too.
  const controller = new AbortController()
  const cancelled = edit
    .execute(
      'call',
      { path: inside, edits: [{ oldText: 'one', newText: 'edited' }], sandbox_permissions: 'workspace-write', justification: 'x' },
      controller.signal,
      undefined,
      context
    )
    .then(() => 'ok', (error) => error)
  await delay(30)
  assert.equal(listPendingEscalations(sessionPath).length, 1, 'the aborted call asked before aborting')
  controller.abort()
  assert.match(String((await cancelled)?.message ?? ''), /cancelled/, 'an aborted question is cancelled, not approved')
  assert.deepEqual(listPendingEscalations(sessionPath), [], 'a cancelled question leaves the queue')

  // 4. The arguments are validated: a malformed request is an error, never a
  //    silently narrower call. A request the current mode already SATISFIES is
  //    not an escalation at all — the call runs under the current (wider) mode
  //    with no question asked; at the ceiling this used to hard-fail.
  assert.equal(
    await ask(inside, undefined, 'why not').then(() => 'ok', () => 'invalid'),
    'invalid',
    'a justification without a mode is invalid'
  )
  mode = 'danger-full-access'
  assert.equal(
    await ask(inside, 'workspace-write').then(() => 'ok', () => 'not-wider'),
    'ok',
    'a request the current mode already satisfies runs without a question'
  )
  assert.deepEqual(listPendingEscalations(sessionPath), [], 'a satisfied request asks nothing')
  assert.equal(mode, 'danger-full-access', 'a satisfied request leaves the session mode untouched')
  assert.equal(
    await ask(inside, 'read-only').then(() => 'ok', () => 'invalid'),
    'invalid',
    'read-only is never a valid escalation target'
  )
  mode = 'read-only'

  const writeParams = { path: outside, content: 'complete write content 中文\n'.repeat(2000), sandbox_permissions: 'danger-full-access', justification: 'review the complete write' }
  const writing = tools[1].execute('write-call', writeParams, undefined, undefined, context).catch(error => error)
  const [writeRequest] = listPendingEscalations(sessionPath)
  assert.deepEqual(writeRequest.operation, { cwd, parameters: writeParams }, 'write approvals retain the full path and content without truncation')
  const originalContent = writeParams.content
  writeParams.content = 'changed caller data'
  assert.equal(writeRequest.operation.parameters.content, originalContent, 'pending details are a snapshot, independent of the caller')
  respondToEscalation(writeRequest.requestId, sessionPath, 'deny')
  assert.match(String((await writing).message), /rejected/)

  const commandPrefix = 'export APPROVAL_FIXTURE=1'
  const bashParams = { command: `printf '%s\\n' '${'complete-command-'.repeat(500)}'\nprintf done`, timeout: 20, sandbox_permissions: 'danger-full-access', justification: 'review the complete command' }
  const bash = createManagedBashTools({
    tasks: { start: () => assert.fail('a denied command must never launch') },
    services: { cwd: '/fallback', settingsManager: { getShellPath: () => '/bin/bash', getShellCommandPrefix: () => commandPrefix } },
    sessionId: 'escalation', sessionPath, maxWaitMs: () => 100, sandboxMode: () => mode, canStart: () => true,
    escalate: input => resolveEscalatedMode({ sessionId: 'escalation', sessionPath, currentMode: mode, onChanged: () => {}, ...input })
  })[0]
  const commanding = bash.execute('bash-call', bashParams, undefined, undefined, context).catch(error => error)
  const [bashRequest] = listPendingEscalations(sessionPath)
  assert.deepEqual(bashRequest.operation, {
    cwd,
    parameters: { ...bashParams, command: `${commandPrefix}\n${bashParams.command}` }
  }, 'bash approvals retain the full effective command, configured prefix, options and actual cwd')
  respondToEscalation(bashRequest.requestId, sessionPath, 'deny')
  assert.match(String((await commanding).message), /rejected/)
}

// ------------------------------------------------------------- real enforcement
const runner = localSandboxProvider().selection()
if (runner === null) {
  // Fail-closed is the contract, so assert it loudly rather than skipping.
  assert.throws(() => confineShellArgv(['/bin/bash', '-c', 'true'], sandboxPolicyFor('workspace-write', workspace)), SandboxUnavailableError, 'with no runner, confinement refuses instead of running on the host')
  console.log('PASS: no sandbox runner on this host — confined commands fail closed, path policy and env scrub verified.')
  console.log('SKIP: kernel sandbox enforcement — no usable sandbox runner on this host')
} else {
  const tasks = new BashTaskManager(join(temporary, 'tasks'), () => {}, () => {})
  const run = async (command, mode) => {
    const task = await tasks.start({
      sessionId: 'check', sessionPath: join(temporary, 'session.jsonl'), toolCallId: 'call', command,
      cwd: workspace, shell: '/bin/bash', args: ['-c'], env: { ...process.env, CHECK_SECRET_TOKEN: 'leak' }, sandboxMode: mode
    })
    await tasks.wait(task.sessionPath, task.id)
    return tasks.output(task.sessionPath, task.id)
  }

  const inWorkspace = join(workspace, 'inside.txt')
  const inTemp = join(await realpath(tmpdir()), 'pith-sandbox-check-temp.txt')
  const outside = join(homedir(), '.pith-sandbox-check-should-not-exist')

  const allowed = await run(`printf ok > ${JSON.stringify(inWorkspace)}; echo done`, 'workspace-write')
  assert.equal(allowed.task.status, 'succeeded', `workspace write allowed under workspace-write: ${JSON.stringify(allowed.output)}`)
  assert.equal(allowed.task.denied ?? false, false, 'an allowed command is not reported as denied')

  const tempAllowed = await run(`printf ok > ${JSON.stringify(inTemp)}; echo done`, 'workspace-write')
  assert.equal(tempAllowed.task.status, 'succeeded', 'the host temp directory is writable under workspace-write')
  await rm(inTemp, { force: true })

  const deniedFileExists = () => spawnSync('/bin/test', ['-e', outside]).status === 0
  const denialSignatures = confineShellArgv(['/bin/bash', '-c', 'true'], sandboxPolicyFor('workspace-write', workspace)).denialSignatures
  const sawDenial = (output) => denialSignatures.some((signature) => output.toLowerCase().includes(signature.toLowerCase()))

  // A shell can swallow a failed redirect (`; echo done`), so the exit code is
  // NOT the denial signal — the file's absence is. This is the case that
  // matters: the write was refused even though the task reports success.
  const masked = await run(`printf no > ${JSON.stringify(outside)}; echo done`, 'workspace-write')
  assert.equal(deniedFileExists(), false, 'a masked denial still never created the file')
  assert.equal(sawDenial(masked.output), true, `the runner said why: ${JSON.stringify(masked.output)}`)

  const escaped = await run(`printf no > ${JSON.stringify(outside)}`, 'workspace-write')
  assert.notEqual(escaped.task.status, 'succeeded', `a write outside the roots fails: ${JSON.stringify(escaped.output)}`)
  assert.equal(escaped.task.denied, true, `the runner reported it as a policy denial: ${JSON.stringify(escaped.output)}`)
  assert.equal(deniedFileExists(), false, 'the refused file was never created')

  const readOnly = await run(`printf no > ${JSON.stringify(join(workspace, 'readonly.txt'))}`, 'read-only')
  assert.notEqual(readOnly.task.status, 'succeeded', 'read-only refuses a write even inside the workspace')
  assert.equal(readOnly.task.denied, true, 'read-only denial is classified as a policy outcome')

  const readOnlyRuns = await run('echo readable', 'read-only')
  assert.equal(readOnlyRuns.task.status, 'succeeded', 'read-only still runs commands and reads')
  assert.equal(readOnlyRuns.output.includes('readable'), true, 'read-only output is delivered')

  // Plan's effective mode IS this read-only profile: the path classes the Plan
  // fixture relies on, plus DSH's deliberate /dev/null write exception.
  const roWorkspaceFile = join(workspace, 'ro-matrix.txt')
  const roTempFile = join(await realpath(tmpdir()), 'pith-sandbox-check-ro-temp.txt')
  const roOutsideFile = join(homedir(), '.pith-sandbox-check-ro-outside')
  const roInterpFile = join(workspace, 'ro-interp.txt')
  const roLinkTarget = join(temporary, 'ro-link-target.txt')
  await writeFile(roLinkTarget, 'seed', 'utf8')
  await symlink(roLinkTarget, join(workspace, 'ro-escape'))
  const roMatrix = [
    `printf no > ${JSON.stringify(roWorkspaceFile)}`,
    `printf no > ${JSON.stringify(roTempFile)}`,
    `printf no > ${JSON.stringify(roOutsideFile)}`,
    `printf no > ${JSON.stringify(join(workspace, 'ro-escape', 'via-link.txt'))}`,
    `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(${JSON.stringify(roInterpFile)},'no')"`,
    'printf ok > /dev/null && echo devnull-ok',
    'echo ro-matrix-done'
  ].join('; ')
  const roResult = await run(roMatrix, 'read-only')
  const exists = (path) => spawnSync('/bin/test', ['-e', path]).status === 0
  assert.equal(roResult.output.includes('ro-matrix-done'), true, `the read-only shell did not run: ${JSON.stringify(roResult.output)}`)
  assert.equal(roResult.output.includes('devnull-ok'), true, `read-only stopped a /dev/null write: ${JSON.stringify(roResult.output)}`)
  assert.equal(exists(roWorkspaceFile), false, 'read-only wrote the workspace file')
  assert.equal(exists(roTempFile), false, 'read-only wrote the temp directory')
  assert.equal(exists(roOutsideFile), false, 'read-only wrote outside the workspace')
  assert.equal(exists(roInterpFile), false, 'an interpreter escaped the read-only file policy')
  assert.equal(await readFile(roLinkTarget, 'utf8'), 'seed', 'a symlink escaped the read-only file policy')
  assert.equal(exists(join(workspace, 'ro-escape', 'via-link.txt')), false, 'the symlink target was written')

  const leaked = await run('printenv CHECK_SECRET_TOKEN || echo absent', 'workspace-write')
  assert.equal(leaked.output.includes('leak'), false, 'a confined shell does not inherit credential-shaped variables')

  // Full access is the documented host path: no wrapper at all.
  assert.equal(confineShellArgv(['/bin/bash', '-c', 'true'], sandboxPolicyFor('danger-full-access', workspace)), null, 'danger-full-access is not wrapped')
  const unconfined = await run(`printf ok > ${JSON.stringify(outside)}; echo done`, 'danger-full-access')
  assert.equal(unconfined.task.status, 'succeeded', 'full access runs on the host')
  await rm(outside, { force: true })

  // A platform with no runner must refuse before a task record exists, so a
  // "running" task can never mean "silently ran unconfined".
  const realPlatform = process.platform
  resetLocalSandboxProvider()
  Object.defineProperty(process, 'platform', { value: 'aix', configurable: true })
  try {
    const before = tasks.list(join(temporary, 'session.jsonl')).length
    await assert.rejects(
      () => tasks.start({
        sessionId: 'check', sessionPath: join(temporary, 'session.jsonl'), toolCallId: 'call', command: 'true',
        cwd: workspace, shell: '/bin/bash', args: ['-c'], env: process.env, sandboxMode: 'workspace-write'
      }),
      SandboxUnavailableError,
      'an unsupported platform fails closed'
    )
    assert.equal(tasks.list(join(temporary, 'session.jsonl')).length, before, 'the refused launch created no task record')
    const status = sandboxStatus('workspace-write')
    assert.equal(status.support, 'dependencies-missing', 'the capability readout agrees that nothing can enforce this')
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    resetLocalSandboxProvider()
  }

  await delay(50)
  console.log(`PASS: DSH sandbox on ${runner.backend} (${runner.enforcement}) — workspace/temp allowed, symlink and .. escapes denied, ` +
    'read-only refuses workspace writes, credential-shaped env is scrubbed, full access bypasses, and a host with no runner fails closed.')
}

await rm(temporary, { recursive: true, force: true })
