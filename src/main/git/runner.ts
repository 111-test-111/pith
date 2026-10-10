import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { GitFailure } from './errors'

const LOCAL_TIMEOUT = 15_000
const NETWORK_TIMEOUT = 120_000
const MAX_OUTPUT = 8 * 1024 * 1024
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Only processes created by this owner are terminated; no persisted PIDs. */
async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      const timer = setTimeout(() => { killer.kill(); reject(new Error('Git process cleanup timed out')) }, 3000)
      killer.once('error', error => { clearTimeout(timer); reject(error) })
      killer.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Git process cleanup failed')) })
    })
    return
  }
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try { process.kill(-child.pid!, value); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; if ((error as NodeJS.ErrnoException).code === 'EPERM') return true; throw error }
  }
  if (!signal('SIGTERM')) return
  let deadline = Date.now() + 500
  while (signal(0) && Date.now() < deadline) await delay(20)
  if (!signal(0)) return
  signal('SIGKILL'); deadline = Date.now() + 1500
  while (signal(0) && Date.now() < deadline) await delay(20)
  if (signal(0)) throw new Error('Git process group did not exit')
}

export class GitRunner {
  private closing = false
  private jobs = new Set<{ cancel: () => void; done: Promise<unknown> }>()
  constructor(private readonly fence: (cwd: string) => void = () => {}) {}
  async run(cwd: string, args: string[], options: { input?: string; network?: boolean; limit?: number; accept?: number[]; signal?: AbortSignal; strictUtf8?: boolean; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
    if (this.closing || options.signal?.aborted) throw new GitFailure('cancelled')
    let cancel = () => {}
    const environment = { ...process.env }
    // App launch environment must not redirect commands to a different checkout/index.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE']) delete environment[key]
    const done = new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
      const child = spawn('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
        cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
        env: { ...environment, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false', GCM_INTERACTIVE: 'never', ...(options.network && !process.env.GIT_SSH_COMMAND ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } : {}) }
      })
      const output: Buffer[] = [], errors: Buffer[] = []
      let bytes = 0, failure: GitFailure | null = null, stopping: Promise<void> | null = null
      const stop = (code: GitFailure['code']) => {
        failure ??= new GitFailure(code)
        stopping ??= terminate(child).catch(() => { this.fence(cwd); failure = new GitFailure('busy') })
      }
      cancel = () => stop('cancelled')
      options.signal?.addEventListener('abort', cancel, { once: true })
      const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? (options.network ? NETWORK_TIMEOUT : LOCAL_TIMEOUT))
      const read = (chunks: Buffer[], chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > (options.limit ?? MAX_OUTPUT)) { stop('output-limit'); return }
        chunks.push(chunk)
      }
      child.stdout.on('data', chunk => read(output, chunk)); child.stderr.on('data', chunk => read(errors, chunk))
      child.stdin.on('error', () => {})
      child.once('error', error => { failure = new GitFailure((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'command', error.message) })
      child.once('exit', () => {
        clearTimeout(timer)
        // Drain hook descendants on exit; waiting for close can deadlock on inherited pipes.
        if (process.platform !== 'win32') stopping ??= terminate(child).catch(() => { this.fence(cwd); failure = new GitFailure('busy') })
      })
      child.once('close', async code => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', cancel)
        // A successful hook can leave descendants behind after Git exits.
        // Keep admission fenced until their owned process group is drained.
        try { if (stopping) await stopping; else if (process.platform !== 'win32') await terminate(child) }
        catch { this.fence(cwd); failure = new GitFailure('busy') }
        const stdout = Buffer.concat(output).toString('utf8'), stderr = Buffer.concat(errors).toString('utf8')
        if (failure) reject(failure)
        else if (options.strictUtf8 && !Buffer.from(stdout, 'utf8').equals(Buffer.concat(output))) reject(new GitFailure('unsupported'))
        else if (code === null || ![0, ...(options.accept ?? [])].includes(code)) reject(new GitFailure('command', stderr.trim() || stdout.trim()))
        else resolve({ stdout, stderr, code })
      })
      child.stdin.end(options.input)
    })
    const job = { cancel: () => cancel(), done }; this.jobs.add(job)
    try { return await done } finally { this.jobs.delete(job) }
  }
  async dispose(): Promise<void> {
    this.closing = true
    const jobs = [...this.jobs]; for (const job of jobs) job.cancel()
    await Promise.allSettled(jobs.map(job => job.done))
  }
}
