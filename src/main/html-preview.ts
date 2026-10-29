import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FileBrowserRequest, HtmlPreviewDTO } from '../shared/types'
import { fileExtension } from '../shared/extension'
import { isHtmlPreviewUrl } from '../shared/html-preview'
import { mediaMimeType } from '../shared/media'
import { previewKindOf } from '../shared/preview'
import { resolveFilePath } from './file-path'

const MAX_ROOTS = 128
const MAX_HTML_BYTES = 16 * 1024 * 1024
const MAX_RESOURCE_BYTES = 128 * 1024 * 1024
const TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.map': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain',
  '.csv': 'text/csv', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.pdf': 'application/pdf'
}

function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}
function safeSegments(parts: string[]): boolean {
  return parts.every(part => !part.startsWith('.') && !/[\\:\x00-\x1f]/.test(part))
}

/** Read-only, lazy loopback server. Grants are app-lifetime and bounded: closing
 * a file pane must not invalidate a URL already opened in the browser. Each
 * canonical workspace root gets its own random origin; outside files use their
 * containing directory. No listing, dotfiles, arbitrary MIME types or symlink
 * escapes are served. Quit closes the listener and all in-flight connections. */
export class HtmlPreviewService {
  private server: Server | undefined
  private starting: Promise<number> | undefined
  private roots = new Map<string, string>() // host → canonical directory
  private disposed = false

  private start(): Promise<number> {
    if (this.disposed) return Promise.reject(new Error('Preview disposed'))
    if (this.starting) return this.starting
    const server = createServer((request, response) => {
      void this.serve(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
    })
    this.server = server
    server.requestTimeout = 15_000
    server.headersTimeout = 10_000
    this.starting = new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        if (this.disposed) { server.close(); reject(new Error('Preview disposed')); return }
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('No preview port')); return }
        server.unref()
        resolve(address.port)
      })
    }).catch(error => { this.starting = undefined; throw error })
    return this.starting
  }

  async open(request: FileBrowserRequest): Promise<HtmlPreviewDTO> {
    try {
      const requested = resolveFilePath(request)
      if (previewKindOf(requested) !== 'html') return { error: 'unreadable' }
      const [path, cwd] = await Promise.all([realpath(requested), realpath(request.cwd)])
      if (previewKindOf(path) !== 'html') return { error: 'unreadable' }
      const info = await stat(path)
      if (!info.isFile()) return { error: info.isDirectory() ? 'directory' : 'unreadable' }
      if (info.size > MAX_HTML_BYTES) return { error: 'tooLarge' }
      const root = within(cwd, path) ? cwd : dirname(path)
      const parts = relative(root, path).split(sep)
      if (!safeSegments(parts)) return { error: 'unreadable' }
      const port = await this.start()
      if (this.disposed) return { error: 'unreadable' }
      let host = [...this.roots].find(([, existing]) => existing === root)?.[0]
      if (!host) {
        if (this.roots.size >= MAX_ROOTS) return { error: 'unreadable' }
        host = `pith-${randomBytes(16).toString('hex')}.localhost:${port}`
        this.roots.set(host, root)
      }
      return { url: `http://${host}/${parts.map(encodeURIComponent).join('/')}` }
    } catch (error) {
      return { error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }
    }
  }

  owns(url: string): boolean {
    return isHtmlPreviewUrl(url) && this.roots.has(new URL(url).host)
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const finish = (status: number) => { response.writeHead(status); response.end() }
    const root = this.roots.get(request.headers.host ?? '')
    if (!root) return finish(403)
    if (request.method !== 'GET' && request.method !== 'HEAD') return finish(405)
    const origin = `http://${request.headers.host}`
    // Refuse another origin using this capability as a cross-site file reader.
    if (request.headers.origin && request.headers.origin !== origin) return finish(403)
    const site = request.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') return finish(403)
    if (request.headers['service-worker']) return finish(403)
    const raw = (request.url ?? '').split('?')[0]
    if (!raw.startsWith('/') || raw.startsWith('//')) return finish(400)
    let parts: string[]
    try { parts = raw.slice(1).split('/').map(decodeURIComponent) } catch { return finish(400) }
    if (!safeSegments(parts) || parts.some(part => part.includes('/'))) return finish(403)
    const candidate = resolve(root, ...parts)
    if (!within(root, candidate)) return finish(403)
    // Re-resolve on EVERY request, including after Refresh and atomic saves.
    let path = await realpath(candidate).catch(() => null)
    if (!path) return finish(404)
    if (!within(root, path) || !safeSegments(relative(root, path).split(sep))) return finish(403)
    if ((await stat(path)).isDirectory()) {
      if (!raw.endsWith('/')) {
        response.writeHead(308, { Location: raw + '/' + (request.url?.includes('?') ? '?' + request.url.split('?').slice(1).join('?') : '') })
        response.end(); return
      }
      path = await realpath(resolve(path, 'index.html')).catch(() => null)
      if (!path) return finish(404)
      if (!within(root, path) || !safeSegments(relative(root, path).split(sep))) return finish(403)
    }
    const ext = fileExtension(path)
    // .svgz is intentionally omitted: it needs an inflater, not raw SVG bytes.
    const type = TYPES[ext] ?? (ext !== '.svgz' ? mediaMimeType(path) : null)
    if (!type) return finish(403)
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile()) return finish(403)
      if (info.size > (type === 'text/html' ? MAX_HTML_BYTES : MAX_RESOURCE_BYTES)) return finish(413)
      // A parent symlink may have changed while opening; compare the opened
      // inode with a freshly confined path before streaming any bytes.
      const checked = await realpath(candidate).catch(() => null)
      if (!checked || !within(root, checked) || !safeSegments(relative(root, checked).split(sep))) return finish(403)
      const freshPath = (await stat(checked)).isDirectory() ? await realpath(resolve(checked, 'index.html')) : checked
      if (!within(root, freshPath) || !safeSegments(relative(root, freshPath).split(sep))) return finish(403)
      const fresh = await stat(freshPath)
      if (fresh.dev !== info.dev || fresh.ino !== info.ino) return finish(409)
      response.setHeader('Content-Type', type)
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      response.setHeader('Content-Security-Policy', "default-src 'self' http: https: data: blob:; script-src 'self' http: https: blob: 'unsafe-inline' 'unsafe-eval'; style-src 'self' http: https: 'unsafe-inline'; object-src 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-same-origin allow-forms allow-popups")
      response.setHeader('Accept-Ranges', 'bytes')
      let start = 0, end = info.size - 1, status = 200
      if (request.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range)
        if (!match || (!match[1] && !match[2])) return finish(416)
        start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]))
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0) {
          response.setHeader('Content-Range', `bytes */${info.size}`)
          return finish(416)
        }
        status = 206
        response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`)
      }
      response.setHeader('Content-Length', Math.max(0, end - start + 1))
      response.writeHead(status)
      if (request.method === 'HEAD' || info.size === 0) { response.end(); return }
      await pipeline(handle.createReadStream({ start, end, autoClose: false }), response).catch(() => {})
    } finally { await handle.close() }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.roots.clear()
    const server = this.server
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

export const htmlPreviews = new HtmlPreviewService()
