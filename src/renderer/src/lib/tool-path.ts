/**
 * Path formatting shared by everything that renders a tool call's target file:
 * the transcript's tool rows (edit/write/read) and the turn's changed-files
 * list. Kept in one module so a path never reads two different ways in the same
 * turn.
 */

export function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/')
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path)
}

/** A leading marker needs the host's home directory; an embedded ~ is literal. */
export function isHomePath(path: string): boolean {
  return path === '~' || path.startsWith('~/')
}

/** Resolves `.` / `..` segments in an already-slashed absolute path. */
export function collapseSegments(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      const last = segments[segments.length - 1]
      if (segments.length > 1 || (last !== undefined && !/^[A-Za-z]:$/.test(last))) segments.pop()
      continue
    }
    segments.push(segment)
  }
  return (path.startsWith('/') ? '/' : '') + segments.join('/')
}

/** Make tool paths uniform; preserve a leading ~ for main to expand before IO. */
export function resolveFromCwd(rawPath: string, cwd: string | null | undefined): string {
  const path = normalizeSlashes(rawPath)
  if (isHomePath(path)) return path
  if (isAbsolutePath(path)) return collapseSegments(path)
  if (!cwd) return path
  const base = normalizeSlashes(cwd).replace(/\/+$/, '')
  if (!base) return path
  return collapseSegments(`${base}/${path}`)
}

/** The path as the user should read it: shortened to the workspace when it can be. */
export function relativize(filePath: string, cwd: string | null | undefined): string {
  if (!cwd) return filePath
  const base = normalizeSlashes(cwd).replace(/\/+$/, '')
  if (!base || !filePath.startsWith(`${base}/`)) return filePath
  return filePath.slice(base.length + 1)
}

/** The directory portion of a slashed path, `''` when the path has none. */
function dirname(slashedPath: string): string {
  const index = slashedPath.lastIndexOf('/')
  if (index < 0) return ''
  if (index === 0) return '/'
  return slashedPath.slice(0, index)
}

/**
 * The directory a tool call's target file lives in, as the transcript should
 * render it beside the filename: relative to the session cwd when the file
 * lies inside it, absolute otherwise (a relative spelling of an outside-cwd
 * directory is not resolvable by the reader). Empty when that directory IS the
 * cwd root — there the filename alone already says everything.
 */
export function displayToolDir(rawPath: string, cwd: string | null | undefined): string {
  if (!rawPath) return ''
  const absolute = resolveFromCwd(rawPath, cwd)
  if (cwd) {
    const base = normalizeSlashes(cwd).replace(/\/+$/, '')
    if (base && absolute.startsWith(`${base}/`)) return dirname(absolute.slice(base.length + 1))
  }
  return dirname(absolute)
}
