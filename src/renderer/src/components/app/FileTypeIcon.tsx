import { memo } from 'react'
import { fileIconSource } from '@/lib/file-icons'

/** File-type artwork is Catppuccin Icons for the whole app — the same set in
 * both interface styles. The SVGs are generated public files, so rows load only
 * the image they display instead of carrying the collection in the bundle. */
export const FileTypeIcon = memo(function FileTypeIcon({ path, className = 'size-4' }: { path: string; className?: string }) {
  return (
    <img
      src={fileIconSource(path)}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
      data-file-icon={path}
    />
  )
})
