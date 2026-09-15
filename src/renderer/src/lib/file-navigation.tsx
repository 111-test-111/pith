import { createContext, useContext, useMemo, type ReactNode } from 'react'

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

interface FileNavigation { cwd: string; openFile: (target: FileTarget) => void }
const FileNavigationContext = createContext<FileNavigation | null>(null)
export const FileBaseDirectory = createContext<string | null>(null)

export function FileNavigationProvider({ cwd, openFile, children }: FileNavigation & { children: ReactNode }) {
  const value = useMemo(() => ({ cwd, openFile }), [cwd, openFile])
  return <FileNavigationContext.Provider value={value}>{children}</FileNavigationContext.Provider>
}

export function useFileNavigation() {
  const navigation = useContext(FileNavigationContext)
  const base = useContext(FileBaseDirectory)
  const open = (href: string) => {
    const target = localFileTarget(href, base ?? navigation?.cwd ?? '')
    if (!target) { void window.pi.openExternal(href); return }
    if (navigation) navigation.openFile(target)
    else void window.pi.openPath(target.path)
  }
  return {
    cwd: base ?? navigation?.cwd ?? '',
    open,
    // Attachment metadata contains literal filesystem paths, not URL anchors.
    openPath: (path: string) => open(encodeURI(path).replaceAll('#', '%23').replaceAll('?', '%3F').replaceAll(':', '%3A'))
  }
}
