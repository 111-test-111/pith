import { useEffect, useState } from 'react'
import { fileDirname } from '@/lib/file-navigation'

/** The artwork of the file's default application, resolved by main through the
 * OS association. Only macOS can identify it for a file URL, and a path we no
 * longer hold keeps the caller's fallback glyph instead of a stale icon. */
export function useDefaultAppIcon(path: string | null | undefined): string | undefined {
  const [resolved, setResolved] = useState<{ path: string; icon: string } | null>(null)
  useEffect(() => {
    if (!path || !window.pi?.fileDefaultApp) return
    let cancelled = false
    void window.pi.fileDefaultApp({ cwd: fileDirname(path), path }).then(application => {
      if (!cancelled) setResolved(application ? { path, icon: application.icon } : null)
    }).catch(() => { if (!cancelled) setResolved(null) })
    return () => { cancelled = true }
  }, [path])
  return resolved && resolved.path === path ? resolved.icon : undefined
}
