import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { localFileTarget, type FileTarget } from '../../../shared/file-links'

export { localFileTarget, fileDirname } from '../../../shared/file-links'
export type { FileTarget } from '../../../shared/file-links'

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
    openPath: (path: string, line?: number) => open(encodeURI(path).replaceAll('#', '%23').replaceAll('?', '%3F').replaceAll(':', '%3A') + (line && line > 0 ? `#L${line}` : ''))
  }
}
