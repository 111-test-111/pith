import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, relative, basename, dirname } from 'node:path'
import type { FileHitDTO, FileKind, FilePreviewDTO } from '../../shared/types'
import { resolveFilePath } from '../file-path'

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.svg'
])

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.cts', '.mts', '.json', '.jsonc',
  '.md', '.mdx', '.txt', '.css', '.scss', '.sass', '.less', '.html', '.htm',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.php', '.sh', '.bash', '.zsh', '.fish', '.yaml', '.yml', '.toml', '.xml',
  '.csv', '.tsv', '.sql', '.graphql', '.gql', '.env', '.lock', '.gitignore',
  '.dockerignore', '.editorconfig', '.prettierrc', '.eslintrc', '.astro', '.vue',
  '.svelte', '.lua', '.r', '.m', '.pl', '.ex', '.exs', '.erl', '.hs', '.clj',
  '.scm', '.vim', '.bat', '.ps1', '.properties', '.gradle', '.cmake', '.mk'
])

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', '.next',
  '.nuxt', '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'target',
  'coverage', '.idea', '.vscode', '.gradle', '.DS_Store', '.pi', '.agents'
])

const MAX_INDEX_FILES = 20000
const MAX_DEPTH = 12
const MAX_TEXT_BYTES = 512 * 1024
const MAX_IMAGE_BYTES = 12 * 1024 * 1024

export function fileKindOf(path: string): FileKind {
  const ext = extname(path).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (!ext) return 'text'
  return 'other'
}

interface IndexedFile {
  path: string
  relPath: string
  name: string
  dir: string
  kind: FileKind
  size: number
  mtime: number
}

export class FileIndex {
  private files: IndexedFile[] = []
  private indexedAt = 0
  private indexing: Promise<void> | null = null

  constructor(private cwd: string) {}

  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.indexedAt < 30_000 && this.files.length) return
    if (this.indexing) return this.indexing
    this.indexing = this.walk()
    try {
      await this.indexing
    } finally {
      this.indexing = null
    }
  }

  private async walk(): Promise<void> {
    const collected: IndexedFile[] = []
    const queue: { dir: string; depth: number }[] = [{ dir: this.cwd, depth: 0 }]
    while (queue.length && collected.length < MAX_INDEX_FILES) {
      const { dir, depth } = queue.shift()!
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.DS_Store')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) {
            queue.push({ dir: full, depth: depth + 1 })
          }
        } else if (entry.isFile()) {
          let info
          try {
            info = await stat(full)
          } catch {
            continue
          }
          const relPath = relative(this.cwd, full)
          collected.push({
            path: full,
            relPath,
            name: entry.name,
            dir: dirname(relPath) === '.' ? '' : dirname(relPath),
            kind: fileKindOf(entry.name),
            size: info.size,
            mtime: info.mtimeMs
          })
          if (collected.length >= MAX_INDEX_FILES) break
        }
      }
    }
    this.files = collected.sort((a, b) => b.mtime - a.mtime)
    this.indexedAt = Date.now()
  }

  search(query: string, limit = 50): FileHitDTO[] {
    const q = query.trim().toLowerCase()
    if (!q) {
      return this.files.slice(0, limit).map(toHit)
    }
    const scored: { file: IndexedFile; score: number }[] = []
    for (const file of this.files) {
      const nameLower = file.name.toLowerCase()
      const relLower = file.relPath.toLowerCase()
      let score = 0
      if (nameLower === q) score = 1000
      else if (nameLower.startsWith(q)) score = 800 - nameLower.length
      else if (nameLower.includes(q)) score = 600 - nameLower.length
      else if (relLower.includes(q)) score = 300 - relLower.length
      else if (q.length > 2 && fuzzyMatch(relLower, q)) score = 100
      else continue
      scored.push({ file, score: score + Math.min(50, file.mtime / 1e12) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map(({ file }) => toHit(file))
  }

  resolve(relOrAbs: string): string {
    return resolveFilePath({ cwd: this.cwd, path: relOrAbs })
  }
}

function toHit(file: IndexedFile): FileHitDTO {
  return {
    path: file.path,
    relPath: file.relPath,
    name: file.name,
    dir: file.dir,
    kind: file.kind,
    size: file.size,
    mtime: file.mtime
  }
}

function fuzzyMatch(haystack: string, needle: string): boolean {
  let i = 0
  for (const char of haystack) {
    if (char === needle[i]) i++
    if (i === needle.length) return true
  }
  return false
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
}

export async function readAttachment(index: FileIndex, path: string): Promise<FilePreviewDTO> {
  const abs = index.resolve(path)
  const kind = fileKindOf(abs)
  const info = await stat(abs)
  const relPath = relative(index.resolve('.'), abs)

  if (kind === 'image' && info.size <= MAX_IMAGE_BYTES) {
    const buffer = await readFile(abs)
    const mimeType = MIME_BY_EXT[extname(abs).toLowerCase()] ?? 'application/octet-stream'
    return {
      path: abs,
      relPath,
      kind: 'image',
      mimeType,
      base64: buffer.toString('base64'),
      truncated: false,
      size: info.size
    }
  }

  if (kind === 'text') {
    const handle = await readFile(abs, { encoding: null }).catch(() => null)
    if (!handle) throw new Error(`Cannot read file: ${path}`)
    const truncated = handle.byteLength > MAX_TEXT_BYTES
    const slice = truncated ? handle.subarray(0, MAX_TEXT_BYTES) : handle
    const text = slice.toString('utf8')
    return {
      path: abs,
      relPath,
      kind: 'text',
      text,
      truncated,
      size: info.size
    }
  }

  return { path: abs, relPath, kind, truncated: false, size: info.size }
}
