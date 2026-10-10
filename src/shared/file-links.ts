/** Pure link routing shared by Electron and the native client. */
const isHomePath = (path: string): boolean => path === '~' || path.startsWith('~/')

export interface FileTarget { path: string; line?: number }

/** Local paths may be relative, file: URLs, or carry :line / #Lline anchors. */
export function localFileTarget(href: string, cwd: string): FileTarget | null {
  if (!href || href.startsWith('#') || href.startsWith('//')) return null
  let path = href
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path)
      path = url.pathname + url.hash
      if (url.hostname && url.hostname !== 'localhost') path = `//${url.hostname}${path}`
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1)
    } catch { return null }
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path) && !/^[^?#:]+\.[\w-]+:\d+(?::\d+)?(?:-\d+)?$/.test(path)) return null
  }
  const location = /(?::(\d+)(?::\d+)?(?:-\d+)?|#L?(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/.exec(path)
  const line = location ? Number(location[1] ?? location[2]) : undefined
  if (location) path = path.slice(0, location.index)
  else path = path.replace(/#.*$/, '')
  try { path = decodeURIComponent(path) } catch { /* literal percent in a filename */ }
  path = path.replaceAll('\\', '/')
  // Do not turn ~/ into cwd/~/ or collapse its .. segments before expansion.
  // FileBrowserStore/main resolves the marker using the host's home directory.
  if (isHomePath(path)) return { path, ...(line && line > 0 ? { line } : {}) }
  const base = cwd.replaceAll('\\', '/')
  const absolute = path.startsWith('/') || /^[a-z]:\//i.test(path) ? path : `${base}/${path}`
  const prefix = absolute.startsWith('//') ? '//' : absolute.startsWith('/') ? '/' : ''
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (parts.length && !/^[a-z]:$/i.test(parts.at(-1)!)) parts.pop() }
    else parts.push(part)
  }
  return { path: prefix + parts.join('/'), ...(line && line > 0 ? { line } : {}) }
}

export function fileDirname(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

