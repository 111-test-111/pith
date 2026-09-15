import { memo } from 'react'
import { FileIcon } from '@react-symbols/icons/utils'
import { basename } from '@/lib/format'

/** User-selected exception to the UI glyph pack: Symbols identifies file
 * formats/frameworks; navigation and toolbar controls remain Hugeicons. */
export const FileTypeIcon = memo(function FileTypeIcon({ path, className = 'size-4' }: { path: string; className?: string }) {
  return <FileIcon fileName={basename(path)} autoAssign aria-hidden="true" focusable="false" className={className} data-file-icon={path} />
})
