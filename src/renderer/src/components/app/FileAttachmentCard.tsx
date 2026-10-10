import { X } from '@/lib/icons'
import { basename, formatBytes } from '@/lib/format'
import { fileDirname, useFileNavigation } from '@/lib/file-navigation'
import { resolveFromCwd } from '@/lib/tool-path'
import { useI18n } from '@/i18n'
import { FileTypeIcon } from './FileTypeIcon'
import { LabelTooltip } from './LabelTooltip'
import { MiddleEllipsis } from './MiddleEllipsis'

/**
 * A referenced file as a card, as tall as the image thumbnails beside it:
 * type artwork over the file name and the absolute directory it lives in (both
 * middle-elided so head and tail survive), the mentioned path and size on the
 * tooltip. Clicking opens the file in the sidebar's preview; the close control
 * rides the card's corner on hover, like the images'. The composer and the
 * edit-and-resend dialog share this.
 */
export function FileAttachmentCard({
  path,
  label,
  size,
  onRemove
}: {
  /** Path the sidebar preview opens on click; a relative spelling (the edit
   * dialog seeds one from the sent message) resolves against the session cwd,
   * so the directory line always reads as a real location. */
  path: string
  /** Mention spelling of the path (workspace-relative where known) — what the
   * tooltip and the close control's accessible name show. */
  label: string
  /** Byte size appended to the tooltip when known. */
  size?: number
  onRemove: () => void
}) {
  const { t } = useI18n()
  const navigation = useFileNavigation()
  const absolute = resolveFromCwd(path, navigation.cwd)
  const name = basename(absolute)
  const dir = fileDirname(absolute)
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
            <MiddleEllipsis name={dir} className="mt-0.5 flex text-caption leading-ui-tight text-muted-foreground" />
          </span>
        </button>
        <button
          type="button"
          aria-label={t('workspace.removeAttachment', { name: label })}
          onClick={onRemove}
          className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-icon text-destructive opacity-0 transition-[opacity,color,background-color] group-hover:opacity-100 hover:bg-destructive/10 focus-visible:opacity-100"
        >
          <X className="size-3" />
        </button>
      </span>
    </LabelTooltip>
  )
}
