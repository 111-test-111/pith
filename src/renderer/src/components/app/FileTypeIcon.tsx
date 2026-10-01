import { memo } from 'react'
import { fileIconSource } from '@/lib/file-icons'
import { FILE_ICON_SIZE } from '@/lib/icon-metrics'

/** File-type artwork is Catppuccin Icons for the whole app — the same set in
 * both interface styles. The SVGs are generated public files, so rows load only
 * the image they display instead of carrying the collection in the bundle. */
export const FileTypeIcon = memo(function FileTypeIcon({ path, variant = 'tree', className }: {
  path: string
  variant?: keyof typeof FILE_ICON_SIZE
  className?: string
}) {
  return (
    <img
      src={fileIconSource(path)}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={FILE_ICON_SIZE[variant]}
      height={FILE_ICON_SIZE[variant]}
      className={className}
      data-file-icon={path}
      data-file-icon-kind={variant}
    />
  )
})
