import { Image, Type, type IconComponent } from '@/lib/icons'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'

/**
 * The SDK's `Model.input` values the app can render. A kind nobody mapped yet
 * is dropped instead of shown as an unlabelled glyph.
 */
const INPUT_KINDS: Record<string, { icon: IconComponent; label: MessageKey }> = {
  text: { icon: Type, label: 'model.inputText' },
  image: { icon: Image, label: 'model.inputImage' }
}

/** Display order, so every row reads text → image whichever way the model
 * declares them. */
const INPUT_ORDER = ['text', 'image']

interface ModelInputBadgesProps {
  /** `ModelDTO.input` (e.g. `['text','image']`). */
  input?: string[]
  className?: string
}

/**
 * What a model accepts as input, as compact chips ("Text", "Image"). Lives in
 * a model row's meta line beside the reasoning/context note, so both model
 * selection surfaces (the composer picker and Settings → default model) say
 * the same thing.
 */
export function ModelInputBadges({ input, className }: ModelInputBadgesProps) {
  const { t } = useI18n()
  const kinds = INPUT_ORDER.filter((kind) => input?.includes(kind))
  if (kinds.length === 0) return null
  return (
    <span
      role="group"
      aria-label={t('model.inputsAria')}
      className={`flex shrink-0 items-center gap-1 ${className ?? ''}`}
    >
      {kinds.map((kind) => {
        const { icon: Icon, label } = INPUT_KINDS[kind]
        return (
          <span
            key={kind}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-item bg-muted px-1 py-px text-micro font-medium leading-ui-tight text-muted-foreground"
          >
            <Icon className="size-2.5 shrink-0" />
            {t(label)}
          </span>
        )
      })}
    </span>
  )
}
