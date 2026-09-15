import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { PassThrough, Readable, Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { MEDIA_SCHEME, isGzippedMedia, mediaMimeType, mediaPathFromUrl } from '../shared/media'

/**
 * Streams local media files to the renderer over a custom scheme, so
 * `<img>`/`<video>`/`<audio>` can load them directly: no base64 through IPC, no
 * whole file in memory, and Chromium keeps ownership of demuxing, decoding and
 * seeking.
 *
 * The scheme must be registered as privileged *before* `app.whenReady()` (see
 * `src/main/index.ts`): `stream: true` is what makes the scheme usable as a
 * media source at all.
 *
 * Range handling is hand-written on purpose. `protocol.handle` +
 * `net.fetch(pathToFileURL(...))` — the documented `registerFileProtocol`
 * replacement — returns a plain 200 with no `Content-Range` no matter which
 * headers it is given (electron/electron#38749, still open on Electron 44), so
 * `<video>` reports `seekable.end(0) === 0` and every seek snaps back to zero.
 * Reading the requested slice ourselves is what makes seeking work.
 */

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        // Without `stream` the scheme cannot back a <video>/<audio> element.
        stream: true
      }
    }
  ])
}

/** One parsed `Range` request, clamped to the file. */
interface ByteRange {
  start: number
  end: number
}

/**
 * `bytes=a-b`, `bytes=a-` and the suffix form `bytes=-n`. Returns `null` when
 * there is no usable single range (an unparsable or multi-range header is served
 * as a plain 200, which is always a legal answer), and `'unsatisfiable'` when
 * the request is syntactically fine but lies outside the file.
 */
function parseRange(header: string | null, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === '')) return null
  if (size === 0) return 'unsatisfiable'
  const start = match[1] === '' ? size - Number(match[2]) : Number(match[1])
  const end = match[1] === '' || match[2] === '' ? size - 1 : Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

function empty(status: number, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers })
}

/** Whatever `Response` accepts as a body in the main process (a web stream). */
type ResponseBody = ConstructorParameters<typeof Response>[0]

/** Ceiling for a medium this handler inflates itself. `.svgz` is small in
 * practice, but a gzip stream can expand enormously and nothing else bounds it
 * — the file on disk is not the payload. */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024

/** `Readable.toWeb` hands the stream to Chromium, which destroys it on abort —
 * that is what keeps an aborted seek from leaking a file descriptor. */
function body(path: string, range?: ByteRange): ResponseBody {
  return Readable.toWeb(createReadStream(path, range)) as unknown as ResponseBody
}

/**
 * The decoded bytes of a gzip-stored medium.
 *
 * The stored bytes cannot be handed to an element with
 * `content-encoding: gzip`: Chromium does not apply that header to a
 * custom-scheme response, so the `<img>` receives a gzip stream, fails to
 * decode it, and the pane reports a broken file. Inflating here — the one place
 * that knows the file is stored compressed — is what makes `.svgz` show up as
 * the SVG it is.
 */
function inflatedBody(path: string): ResponseBody {
  const output = new PassThrough()
  let size = 0
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      if (size > MAX_INFLATED_BYTES) callback(new Error('Media is too large once inflated'))
      else callback(null, chunk)
    }
  })
  // `pipeline` (not `.pipe()`) is what carries an upstream failure — a truncated
  // gzip, a read error — to the stream the response is reading from.
  void pipeline(createReadStream(path), createGunzip(), guard, output).catch(error => output.destroy(error as Error))
  return Readable.toWeb(output) as unknown as ResponseBody
}

async function serve(request: Request): Promise<Response> {
  const path = mediaPathFromUrl(request.url)
  // Only files an element can play: the extension allowlist is what keeps this
  // scheme from being a general-purpose local file reader.
  if (!path || !isAbsolute(path)) return empty(400)
  const type = mediaMimeType(path)
  if (!type) return empty(403)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return empty(404)

  // Local files change under us (the agent writes them), so nothing is cached:
  // a remount of the element re-reads the current bytes.
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store'
  }
  // `.svgz` is stored gzip-encoded, so it is inflated here and served as the
  // SVG it is. No ranges either: the file on disk is not the byte range an image
  // would be seeking in, and an <img> never asks for one.
  if (isGzippedMedia(path)) return new Response(inflatedBody(path), {
    status: 200,
    headers: { 'content-type': type, 'cache-control': 'no-store' }
  })
  const range = parseRange(request.headers.get('range'), info.size)
  if (range === 'unsatisfiable') return empty(416, { ...headers, 'content-range': `bytes */${info.size}` })
  if (!range) return new Response(body(path), { status: 200, headers: { ...headers, 'content-length': String(info.size) } })
  return new Response(body(path, range), {
    status: 206,
    headers: {
      ...headers,
      'content-length': String(range.end - range.start + 1),
      'content-range': `bytes ${range.start}-${range.end}/${info.size}`
    }
  })
}

/** Must run after `app.whenReady()`, on the session the window uses. */
export function installMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, mediaRequestHandler)
}

/**
 * The one handler, exported so a check harness can wrap it to count requests
 * without reimplementing it. Answers a `Response` for every request; failures
 * collapse to a 500 rather than an unhandled rejection.
 */
export function mediaRequestHandler(request: Request): Promise<Response> {
  return serve(request).catch(() => empty(500))
}
