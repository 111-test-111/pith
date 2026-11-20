import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { localFileTarget, type FileTarget } from '../../../shared/file-links'
import type { FileView } from '@/state/file-browser-store'

export { localFileTarget, fileDirname } from '../../../shared/file-links'
export type { FileTarget } from '../../../shared/file-links'

/** `view` is a hint for when the file's tab is created; an explicit user view
 * choice on an existing tab still wins through the store's own precedence. */
interface FileNavigation { cwd: string; openFile: (target: FileTarget, view?: FileView) => void }
const FileNavigationContext = createContext<FileNavigation | null>(null)
export const FileBaseDirectory = createContext<string | null>(null)

export function FileNavigationProvider({ cwd, openFile, children }: FileNavigation & { children: ReactNode }) {
  const value = useMemo(() => ({ cwd, openFile }), [cwd, openFile])
  return <FileNavigationContext.Provider value={value}>{children}</FileNavigationContext.Provider>
}

export function useFileNavigation() {
  const navigation = useContext(FileNavigationContext)
  const base = useContext(FileBaseDirectory)
  return useMemo(() => {
    const open = (href: string, view?: FileView) => {
      const target = localFileTarget(href, base ?? navigation?.cwd ?? '')
      if (!target) { void window.pi.openExternal(href); return }
      if (navigation) navigation.openFile(target, view)
      else void window.pi.openPath(target.path)
    }
    // Attachment metadata contains literal filesystem paths, not URL anchors.
    const hrefFor = (path: string, line?: number) =>
      encodeURI(path).replaceAll('#', '%23').replaceAll('?', '%3F').replaceAll(':', '%3A') + (line && line > 0 ? `#L${line}` : '')
    return {
      cwd: base ?? navigation?.cwd ?? '',
      open,
      openPath: (path: string, line?: number) => open(hrefFor(path, line)),
      /** A changed-file row opens that file's diff in the rail — the same
       * navigation, landed on the diff view instead of source. */
      openDiff: (path: string) => open(hrefFor(path), 'diff')
    }
  }, [navigation, base])
}
