import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { ImagePlus, LinkSimple, X } from '@/lib/icons'
import { MorphingModal } from '@/components/motion/morphing-modal'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { Input } from '@/components/motion/input'
import { extractUserDisplay } from '@/lib/user-message'
import { readImageAttachment, resolveAttachmentFile } from '@/lib/attachments'
import { useI18n } from '@/i18n'
import type {
  ImageContent,
  ModelDTO,
  ThinkingLevel,
  UserMsg
} from '../../../../shared/types'
import { ModelPicker } from './ModelPicker'
import { ImagePreviewGroup, PreviewThumb } from './ImagePreview'
import { FileAttachmentCard } from './FileAttachmentCard'

/** What the dialog hands back to the resend path: the user's edit, with file
 * references as paths so the main process can re-inline current contents. */
export interface EditMessagePayload {
  text: string
  images: ImageContent[]
  files: string[]
}

interface EditImage {
  id: string
  name: string
  dataUrl: string
  image: ImageContent
}

interface EditFile {
  id: string
  /** Workspace-relative or absolute path passed back to the main process. */
  path: string
  /** The path as shown/mentioned — also what removing the chip strips from the text. */
  label: string
}

let editSeq = 0
const nextId = () => `edit-${Date.now()}-${editSeq++}`

/**
 * "Edit and resend" for one user message: a full-fidelity editor — text plus
 * the message's image attachments and file references, each removable, with
 * new ones attachable — and the session's model/thinking picker. Resend rewinds
 * the session to the message and re-prompts with the edited payload; Cancel
 * leaves the transcript untouched.
 */
export function EditMessageDialog({
  open,
  message,
  models,
  model,
  thinkingLevel,
  availableThinkingLevels,
  onModelChange,
  onThinkingLevelChange,
  onResend,
  onCancel
}: {
  open: boolean
  /** The message being edited; the dialog seeds itself from it on open. */
  message: UserMsg | null
  models: ModelDTO[]
  model: ModelDTO | null
  thinkingLevel: ThinkingLevel
  availableThinkingLevels: ThinkingLevel[]
  onModelChange: (model: ModelDTO) => void
  onThinkingLevelChange: (level: ThinkingLevel) => void
  onResend: (payload: EditMessagePayload) => void
  /** Dismiss without resending (backdrop, Esc, or Cancel). */
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [images, setImages] = useState<EditImage[]>([])
  const [files, setFiles] = useState<EditFile[]>([])
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const targetTimestamp = message?.timestamp

  // Seed from the target message each time the dialog opens. `open` (not the
  // message identity) drives this, so re-renders while editing never clobber
  // the draft.
  useEffect(() => {
    if (!open || !message) return
    const display = extractUserDisplay(message.content)
    setText(display.text)
    setImages(
      display.images.map((image, index) => ({
        id: nextId(),
        name: t('imagePreview.attachment', { index: index + 1 }),
        dataUrl: `data:${image.mimeType};base64,${image.data}`,
        image
      }))
    )
    // Stored file references are `<file path>` values — workspace-relative
    // paths (or absolute for outside-cwd picks) that the main process resolves.
    setFiles(display.files.map((path) => ({ id: nextId(), path, label: path })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetTimestamp, t])

  const addImage = (file: File) => {
    void readImageAttachment(file).then((read) => {
      if (read) setImages((current) => [...current, { id: nextId(), ...read }])
    })
  }

  const addFile = async (file: File) => {
    // Same intake as the composer: the picked/pasted File's own path first, the
    // workspace index only as the fallback for a File with no local backing.
    const target = await resolveAttachmentFile(file)
    if (!target) return
    setFiles((current) =>
      current.some((entry) => entry.path === target.path)
        ? current
        : [...current, { id: nextId(), path: target.path, label: target.relPath }]
    )
  }

  /**
   * Paste files into the editor, exactly as the composer does. An image on the
   * clipboard has bytes but no path, a copied file has one — the shared intake
   * resolves both. Text-only pastes are left to the textarea.
   */
  const handlePaste = (event: ReactClipboardEvent<HTMLInputElement>) => {
    const pasted = Array.from(event.clipboardData.files)
    if (!pasted.length) return
    // A clipboard holding files must not also paste their names as text.
    event.preventDefault()
    for (const file of pasted) {
      if (file.type.startsWith('image/')) addImage(file)
      else void addFile(file)
    }
  }

  const removeImage = (id: string) => setImages((current) => current.filter((entry) => entry.id !== id))

  /** Removing a reference also strips its `@mention` from the draft, mirroring
   * the composer's chip removal. */
  const removeFile = (id: string) => {
    const target = files.find((entry) => entry.id === id)
    setFiles((current) => current.filter((entry) => entry.id !== id))
    if (target) {
      setText((value) => value.replace(`@${target.label}`, '').replace(/ {2,}/g, ' ').trimStart())
    }
  }

  const canSubmit = text.trim().length > 0 || images.length > 0 || files.length > 0

  const submit = () => {
    if (!canSubmit) return
    onResend({
      text: text.trim(),
      images: images.map((entry) => entry.image),
      files: files.map((entry) => entry.path)
    })
  }

  // Cmd/Ctrl+Enter resends; plain Enter keeps inserting newlines (this is a
  // multi-line message editor, not the composer).
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }

  // MorphingModal has no built-in Escape handling. The model picker's Select
  // also closes on Escape, so let that win first (its trigger still reports
  // aria-expanded=true while this handler runs).
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]')) return
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel])

  return (
    <MorphingModal
      viewId={open ? 'edit-message' : null}
      onClose={onCancel}
      placement="center"
      // `overflow-visible` (overriding the panel's `overflow-hidden`) is
      // load-bearing: the model picker's dropdown is absolutely positioned
      // inside the panel and would otherwise be clipped away.
      className="max-w-xl overflow-visible"
    >
      <div role="dialog" aria-modal="true" aria-label={t('chat.editMessageTitle')}>
        <h2 className="text-sm font-semibold text-foreground">
          {t('chat.editMessageTitle')}
        </h2>

        <div className="mt-3 max-h-[55vh] overflow-y-auto p-1">
          <Input
            multiline
            rows={6}
            value={text}
            onChange={setText}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            aria-label={t('chat.editMessageBodyAria')}
            placeholder={t('composer.placeholder')}
            classNames={{ input: 'text-content leading-content' }}
            attachments={
              images.length || files.length ? (
                <ImagePreviewGroup>
                  {images.map((image) => (
                    <span key={image.id} className="group relative">
                      <PreviewThumb
                        src={image.dataUrl}
                        alt={image.name}
                        framed
                        className="h-14 w-14 rounded-xl"
                        imageClassName="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        aria-label={t('workspace.removeAttachment', { name: image.name })}
                        onClick={() => removeImage(image.id)}
                        className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-icon text-destructive opacity-0 transition-[opacity,color,background-color] group-hover:opacity-100 hover:bg-destructive/10 focus-visible:opacity-100"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                  {files.map((file) => (
                    <FileAttachmentCard
                      key={file.id}
                      path={file.path}
                      label={file.label}
                      onRemove={() => removeFile(file.id)}
                    />
                  ))}
                </ImagePreviewGroup>
              ) : undefined
            }
          />
        </div>

        {/* Kept OUT of the scroll container above: that container clips on both
            axes (`overflow-y-auto` forces `overflow-x` off `visible`), which
            would cut off the model picker's dropdown. */}
        <div className="mt-3 flex items-center gap-1">
          <Tooltip content={t('composer.attachImage')}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('composer.attachImage')}
              onClick={() => imageInputRef.current?.click()}
            >
              <ImagePlus className="size-4" />
            </Button>
          </Tooltip>
          <Tooltip content={t('composer.attachFile')}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('composer.attachFile')}
              onClick={() => fileInputRef.current?.click()}
            >
              <LinkSimple className="size-4" />
            </Button>
          </Tooltip>
          <div className="ml-auto">
            <ModelPicker
              models={models}
              value={model ? `${model.providerId}/${model.id}` : null}
              thinkingLevel={thinkingLevel}
              availableThinkingLevels={availableThinkingLevels}
              onChange={onModelChange}
              onThinkingLevelChange={onThinkingLevelChange}
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={submit}>
            {t('chat.editMessageResend')}
          </Button>
        </div>

        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            Array.from(event.target.files ?? []).forEach(addImage)
            event.target.value = ''
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          hidden
          onChange={async (event) => {
            const picked = Array.from(event.target.files ?? [])
            for (const file of picked) await addFile(file)
            event.target.value = ''
          }}
        />
      </div>
    </MorphingModal>
  )
}
