import { memo } from 'react'
import { fileIconSource } from '@/lib/file-icons'
import { FILE_ICON_SIZE } from '@/lib/icon-metrics'
import { useUiStyle } from '@/lib/ui-style'

/** Square uses angular Pierre adaptations; squircle uses native Pierre artwork.
 * Both load individual offline SVG assets and keep the same row/card sizes. */
export const FileTypeIcon = memo(function FileTypeIcon({ path, variant = 'tree', className }: {
  path: string
  variant?: keyof typeof FILE_ICON_SIZE
  className?: string
}) {
  const [uiStyle] = useUiStyle()
  return (
    <img
      src={fileIconSource(path, uiStyle)}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={FILE_ICON_SIZE[variant]}
      height={FILE_ICON_SIZE[variant]}
      className={className}
      data-file-icon={path}
      data-file-icon-kind={variant}
      data-file-icon-family={uiStyle === 'squircle' ? 'pierre' : 'pierre-square'}
    />
  )
})
