import { execFile } from 'node:child_process'
import { open, readdir, stat, realpath } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { FileBrowserError, FileBrowserRequest, FileDirectoryDTO, FileDocumentDTO, FileGitDiffDTO } from '../shared/types'
import { previewKindOf, readsAsText, textReadLimit } from '../shared/preview'
import { resolveFilePath } from './file-path'
import { decodeFileText } from './text-decoding'
import type { TextEncoding } from '../shared/file-preview'

const exec = promisify(execFile)
const PAGE_SIZE = 300

function errorCode(error: unknown): FileBrowserError {
  return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
}

async function git(cwd: string, args: string[], diffExit = false): Promise<string> {
  const result = await exec('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotePath=false', '-c', 'color.ui=false', ...args], {
    cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  }).catch(error => {
    if (diffExit && error.code === 1 && typeof error.stdout === 'string') return { stdout: error.stdout }
    throw error
  })
  return result.stdout
}

async function gitRoot(path: string): Promise<string | null> {
  // A deleted file (including one whose parent was removed) still has a diff.
  let dir = dirname(path)
  while (true) {
    try { if ((await stat(dir)).isDirectory()) break } catch { /* climb */ }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return git(dir, ['rev-parse', '--show-toplevel']).then(value => value.trimEnd()).catch(() => null)
}

async function physicalFilePath(path: string): Promise<string> {
  // Git reports a physical root, while a workspace may use /var → /private/var
  // or another directory alias. Preserve the final symlink as a Git entry.
  let parent = dirname(path)
  while (true) {
    try { return resolve(await realpath(parent), relative(parent, path)) } catch {
      const next = dirname(parent)
      if (next === parent) return path
      parent = next
    }
  }
}

/** Bounded decoder shared by source panes and archive thumbnails. Callers gate
 * document reads through readsAsText before using it. */
export async function readFileText(path: string, limit: number, encoding: TextEncoding = 'auto'): Promise<Pick<FileDocumentDTO, 'text' | 'encoding' | 'size' | 'truncated' | 'error'>> {
  // O_NONBLOCK keeps FIFO/device paths from hanging the Electron main process.
  const { constants } = await import('node:fs')
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) return { size: 0, truncated: false, error: info.isDirectory() ? 'directory' : 'unreadable' }
    const buffer = Buffer.alloc(limit + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!read.bytesRead) break
      bytesRead += read.bytesRead
    }
    const truncated = bytesRead > limit || info.size > limit
    const bytes = buffer.subarray(0, Math.min(bytesRead, limit))
    const decoded = decodeFileText(bytes, truncated, encoding)
    return decoded ? { ...decoded, size: info.size, truncated } : { size: info.size, truncated: false, error: 'binary' }
  } finally { await handle.close() }
}

export async function listFileDirectory(request: FileBrowserRequest, offset = 0): Promise<FileDirectoryDTO> {
  let path = ''
  try {
    path = resolveFilePath(request)
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.name !== '.git' && entry.name !== '.DS_Store')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'en', { numeric: true }))
    const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
    // Do not expand symlink directories: cycles and outside trees remain links.
    return { path, entries: entries.slice(start, start + PAGE_SIZE).map(entry => ({ name: entry.name, path: resolve(path, entry.name).split(sep).join('/'), directory: entry.isDirectory(), symlink: entry.isSymbolicLink() })),
      ...(start + PAGE_SIZE < entries.length ? { nextOffset: start + PAGE_SIZE } : {}) }
  } catch (error) { return { path, entries: [], error: errorCode(error) } }
}

export async function readFileDocument(request: FileBrowserRequest): Promise<FileDocumentDTO> {
  let path = '', root: string | null = null
  try {
    path = resolveFilePath(request)
    // The routing table decides whether this path is text at all. A medium, a
    // PDF, a spreadsheet or a font read as a 512 KiB document would come back
    // as "binary" — or, for a 2 GiB video, as its first 512 KiB claiming to be
    // a file. This is the invariant, not a renderer convention: `shared/preview.ts`
    // is what the pane dispatches on, so the two cannot disagree.
    const kind = previewKindOf(path)
    // Git discovery and the bounded read are independent; don't put a child
    // process round trip in front of the first source buffer.
    const [gitDirectory, content] = await Promise.all([
      gitRoot(path),
      readsAsText(kind)
        ? readFileText(path, textReadLimit(kind), request.encoding).catch(error => ({ size: 0, truncated: false, error: errorCode(error) }))
        : Promise.resolve({ size: 0, truncated: false, error: 'binary' as const })
    ])
    root = gitDirectory
    return { path, relativePath: relative(request.cwd, path), gitRoot: root, ...content }
  } catch (error) {
    return { path, relativePath: path, gitRoot: root, size: 0, truncated: false, error: errorCode(error) }
  }
}

/** HEAD → working file includes staged and unstaged changes. Git itself handles
 * renames/deletions and attributes; external diff/textconv programs never run. */
export async function readFileGitDiff(request: FileBrowserRequest): Promise<FileGitDiffDTO> {
  let root: string | null = null
  try {
    const path = resolveFilePath(request)
    root = await gitRoot(path)
    if (!root) return { gitRoot: null, patch: '', binary: false }
    const rel = relative(root, await physicalFilePath(path))
    let existsAtHead = false
    try { await git(root, ['cat-file', '-e', `HEAD:${rel.replaceAll('\\', '/')}`]); existsAtHead = true } catch { /* unborn HEAD or new file */ }
    if (existsAtHead) {
      const patch = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', 'HEAD', '--', rel])
      return { gitRoot: root, patch, binary: /^Binary files .* differ$/m.test(patch) }
    }
    // Untracked files and newly staged files are additions relative to HEAD.
    const content = await readFileText(path, textReadLimit(previewKindOf(path)))
    if (content.error) return { gitRoot: root, patch: '', binary: content.error === 'binary', error: content.error === 'binary' ? undefined : content.error }
    if (content.truncated) return { gitRoot: root, patch: '', binary: false, error: 'tooLarge' }
    const patch = await git(root, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--unified=3', '--', '/dev/null', rel], true)
    return { gitRoot: root, patch, binary: /^Binary files .* differ$/m.test(patch) }
  } catch (error) {
    return { gitRoot: root, patch: '', binary: false, error: (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'tooLarge' : 'git' }
  }
}
