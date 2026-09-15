/**
 * Media preview facts shared by the main-process protocol handler and the
 * renderer: which extensions are previewable, as what, and how a local file
 * becomes a URL the media elements can load.
 *
 * Chromium does every bit of the actual work (demuxing, decoding, seeking,
 * image decoding), so this file only decides *what* is a previewable medium.
 * Both halves of the URL contract live here so the encode and decode sides
 * cannot drift apart.
 */
import { fileExtension } from './extension'

export type MediaKind = 'image' | 'video' | 'audio'
/** Custom scheme serving local files as seekable media. */
export const MEDIA_SCHEME = 'pith-media'

/** Fixed host segment of every media URL: a non-empty host keeps Chromium's
 * standard-scheme URL parsing predictable and gives the handler one cheap
 * rejection test. */
export const MEDIA_HOST = 'media'

/**
 * Extensions Chromium can decode, mapped to the MIME type the media element
 * must see: the response content type is what selects the demuxer, so it has to
 * be exact (a `.mkv` served as `application/octet-stream` will not play).
 * Verified against Electron 44 on macOS — see `scripts/check-media-preview.mjs`.
 */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.cur': 'image/x-icon',
  '.svg': 'image/svg+xml',
  // Gzipped SVG: stored compressed, so the handler inflates it before serving
  // it as an image (see isGzippedMedia).
  '.svgz': 'image/svg+xml'
}

const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  // Chromium's Matroska demuxer accepts H.264/VP9/AV1 with Opus/Vorbis here.
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg'
}

const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
  '.mka': 'audio/x-matroska'
}

/**
 * Formats we still recognize as media but cannot preview, because Chromium has
 * no decoder for them (HEIC/TIFF stills, AVI/WMV/FLV/MPEG containers, lossless
 * audio outside FLAC/WAV). They get an explicit "no preview here" notice
 * instead of the generic "only text files can be previewed" message, and they
 * are never read as text.
 *
 * Keep this list free of anything that is also source: `.ts`/`.mts` are
 * TypeScript (not MPEG-TS) and `.dts` is a device-tree source, and a file on
 * this list can never be opened as text again.
 */
const UNSUPPORTED = new Set([
  '.heic', '.heif', '.tif', '.tiff', '.psd', '.raw', '.cr2', '.nef', '.dng', '.jxl',
  '.avi', '.wmv', '.asf', '.flv', '.f4v', '.mpg', '.mpeg', '.mpe', '.m2v', '.vob',
  '.m2ts', '.3gp', '.3g2', '.rm', '.rmvb', '.divx', '.dv', '.mxf',
  '.aif', '.aiff', '.au', '.wma', '.ape', '.wv', '.dsf', '.dff', '.mid', '.midi',
  '.amr', '.ra', '.cda', '.ac3'
])

/** The previewable kind of a path, or `null` (text, or a format we cannot play). */
export function mediaKindOf(path: string): MediaKind | null {
  const ext = fileExtension(path)
  if (IMAGE_TYPES[ext]) return 'image'
  if (VIDEO_TYPES[ext]) return 'video'
  if (AUDIO_TYPES[ext]) return 'audio'
  return null
}

/** The MIME type the media element needs, or `null` for a non-previewable path. */
export function mediaMimeType(path: string): string | null {
  const ext = fileExtension(path)
  return IMAGE_TYPES[ext] ?? VIDEO_TYPES[ext] ?? AUDIO_TYPES[ext] ?? null
}

/** A recognized medium Chromium cannot decode — worth its own notice. */
export function isUnsupportedMedia(path: string): boolean {
  return UNSUPPORTED.has(fileExtension(path))
}

/**
 * Media the file itself stores gzip-encoded, so the handler has to inflate it
 * rather than serve the compressed bytes as if they were the image. Only the
 * one format: `.svgz` is gzipped SVG by definition, while a `.png` that happens
 * to start with a gzip header is a broken file, not an encoded one.
 *
 * `content-encoding: gzip` is NOT a workable alternative — Chromium does not
 * apply it to a custom-scheme response, so an `<img>` would receive the gzip
 * stream and fail (verified: the image errors, it does not decode).
 */
export function isGzippedMedia(path: string): boolean {
  return fileExtension(path) === '.svgz'
}

/**
 * `pith-media://media/<path>` for an absolute local path.
 *
 * Each segment is percent-encoded individually, so real slashes stay in the URL
 * (readable, and `%2F` never has to survive canonicalization) while `#`, `?`,
 * `%` and spaces inside a file name cannot terminate or break it. Windows
 * drive paths get the leading slash Chromium's standard-scheme parser expects.
 */
export function mediaUrl(path: string): string {
  const posix = path.replaceAll('\\', '/')
  const encoded = posix.split('/').map(encodeURIComponent).join('/')
  return `${MEDIA_SCHEME}://${MEDIA_HOST}${encoded.startsWith('/') ? '' : '/'}${encoded}`
}

/**
 * The inverse of `mediaUrl`, used by the protocol handler. Decoded by hand
 * rather than through `new URL` so it agrees with the encoder above whatever
 * canonicalization Chromium applied on the way in.
 */
export function mediaPathFromUrl(url: string): string | null {
  // The host separator IS the path's leading slash (`pith-media://media/Users/…`),
  // so only the scheme and host are stripped here.
  const prefix = `${MEDIA_SCHEME}://${MEDIA_HOST}`
  if (!url.startsWith(prefix)) return null
  let path = url.slice(prefix.length)
  // `pith-media://mediaX/…` must not read as this host.
  if (!path.startsWith('/')) return null
  const cut = path.search(/[?#]/)
  if (cut >= 0) path = path.slice(0, cut)
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  if (!path || path.includes('\0')) return null
  // A Windows drive path arrives as `/C:/…`; every other path keeps its slash.
  return /^\/[a-zA-Z]:\//.test(path) ? path.slice(1) : path
}
