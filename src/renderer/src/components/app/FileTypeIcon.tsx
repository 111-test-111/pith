import { memo } from 'react'
import { fileIconSource } from '@/lib/file-icons'

/** User-selected exception to the UI glyph pack: vscode-icons identifies file
 * formats/frameworks; navigation and toolbar controls remain Lucide. The
 * artwork is a plain SVG file (generated into the public directory by
 * `scripts/prepare-file-icons.mjs`), so it is drawn by the browser as an image
 * rather than carried in the renderer bundle. */
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
