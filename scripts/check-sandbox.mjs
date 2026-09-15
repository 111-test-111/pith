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
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
export { localSandboxProvider, resetLocalSandboxProvider } from './src/main/sandbox/local';
export { SandboxUnavailableError } from './src/main/sandbox/types';`,
    resolveDir: resolve('.')
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile
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
  SandboxUnavailableError
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

// ------------------------------------------------------------- real enforcement
const runner = localSandboxProvider().selection()
if (runner === null) {
  // Fail-closed is the contract, so assert it loudly rather than skipping.
  assert.throws(() => confineShellArgv(['/bin/bash', '-c', 'true'], sandboxPolicyFor('workspace-write', workspace)), SandboxUnavailableError, 'with no runner, confinement refuses instead of running on the host')
  console.log('PASS: no sandbox runner on this host — confined commands fail closed, path policy and env scrub verified.')
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
