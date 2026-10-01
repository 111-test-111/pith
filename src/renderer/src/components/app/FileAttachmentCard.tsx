import { X } from '@/lib/icons'
import { basename, formatBytes } from '@/lib/format'
import { fileDirname, useFileNavigation } from '@/lib/file-navigation'
import { useI18n } from '@/i18n'
import { FileTypeIcon } from './FileTypeIcon'
import { LabelTooltip } from './LabelTooltip'
import { MiddleEllipsis } from './MiddleEllipsis'

/**
 * A referenced file as a card, as tall as the image thumbnails beside it:
 * type artwork over the file name and its directory (both middle-elided so
 * head and tail survive), the full path and size on the tooltip. Clicking
 * opens the file in the sidebar's preview; the close control rides the card's
 * corner on hover, like the images'. The composer and the edit-and-resend
 * dialog share this.
 */
export function FileAttachmentCard({
  path,
  label,
  size,
  onRemove
}: {
  /** Absolute path the sidebar preview opens on click. */
  path: string
  /** Display path (workspace-relative where known) — the card's name and
   * directory lines derive from it, and the tooltip shows it. */
  label: string
  /** Byte size appended to the tooltip when known. */
  size?: number
  onRemove: () => void
}) {
  const { t } = useI18n()
  const navigation = useFileNavigation()
  const name = basename(label)
  const dir = fileDirname(label)
  return (
    <LabelTooltip content={size === undefined ? label : `${label} · ${formatBytes(size)}`} wrap>
      {/* The span owns the tooltip's `aria-describedby` and the hover group
          the corner close shares with the image thumbs. */}
      <span data-attachment-card="" className="group relative">
        <button
          type="button"
          data-attachment-frame=""
          aria-label={t('review.openFile', { name })}
          onClick={() => navigation.openPath(path)}
          className="flex h-14 w-56 items-center gap-2.5 rounded-xl border border-border bg-transparent px-3 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <FileTypeIcon path={path} variant="card" className="shrink-0" />
          <span className="min-w-0 flex-1">
            <MiddleEllipsis name={name} className="flex text-xs font-medium text-foreground" />
            <MiddleEllipsis name={dir === '/' ? '.' : dir} className="mt-0.5 flex text-[11px] leading-4 text-muted-foreground" />
          </span>
        </button>
        <button
          type="button"
          aria-label={t('workspace.removeAttachment', { name: label })}
          onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-capsule text-destructive opacity-0 transition-[opacity,color,background-color] group-hover:opacity-100 hover:bg-destructive/10 focus-visible:opacity-100"
        >
          <X className="size-3" />
        </button>
      </span>
    </LabelTooltip>
  )
}
