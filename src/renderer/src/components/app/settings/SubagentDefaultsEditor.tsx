import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/motion/button'
import { Checkbox } from '@/components/motion/checkbox'
import { CenterMorphModal, CenterMorphModalContent } from '@/components/motion/center-morph-modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select'
import { FORM_FIELD_TITLE, FORM_PANEL_TITLE } from '@/lib/form-standard'
import { useI18n } from '@/i18n'
import type { ModelDTO, SubagentProfileDefaultsPayload, SubagentProfileDTO, ThinkingLevel } from '../../../../../shared/types'
import { ModelPicker } from '../ModelPicker'
import { FadeScroll } from '../FadeScroll'

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** The role file owns defaults; dispatch arguments may override each one. */
export function SubagentDefaultsEditor({ profile, onSave, onClose }: {
  profile: SubagentProfileDTO
  onSave: (defaults: SubagentProfileDefaultsPayload) => Promise<void>
  onClose: () => void
}) {
  const { t } = useI18n()
  const modelLabelId = useId()
  const [model, setModel] = useState<string | null>(profile.model ?? null)
  const [thinking, setThinking] = useState<ThinkingLevel | null>(profile.thinking ?? null)
  const [inheritContext, setInheritContext] = useState(profile.inheritContext)
  const [runInBackground, setRunInBackground] = useState(profile.runInBackground)
  const [models, setModels] = useState<ModelDTO[]>([])
  const [loadingModels, setLoadingModels] = useState(true)
  const [modelsError, setModelsError] = useState(false)
  const [modelLoad, setModelLoad] = useState(0)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const submitting = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoadingModels(true)
    setModelsError(false)
    void window.pi.models().then(
      (next) => { if (!cancelled) setModels(next) },
      () => { if (!cancelled) setModelsError(true) }
    ).finally(() => { if (!cancelled) setLoadingModels(false) })
    return () => { cancelled = true }
  }, [modelLoad])

  const selectedModel = models.find(item => `${item.providerId}/${item.id}` === model)
  const thinkingOptions = selectedModel?.thinkingLevels ?? (!selectedModel || selectedModel.reasoning ? THINKING_LEVELS : ['off'] as const)
  const dirty = model !== (profile.model ?? null) || thinking !== (profile.thinking ?? null) ||
    inheritContext !== profile.inheritContext || runInBackground !== profile.runInBackground
  const field = (label: string, content: ReactNode, hint?: string, id?: string) => (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span id={id} data-subagent-default-title className={FORM_FIELD_TITLE}>{label}</span>
      {content}
      {hint ? <p className="text-xs leading-4 text-muted-foreground">{hint}</p> : null}
    </div>
  )
  const save = async () => {
    if (!dirty || submitting.current) return
    submitting.current = true
    setSaving(true)
    setFailed(false)
    try {
      await onSave({ model, thinking, inheritContext, runInBackground })
      onClose()
    } catch { setFailed(true) }
    finally { submitting.current = false; setSaving(false) }
  }

  return (
    <CenterMorphModal open onOpenChange={(open) => { if (!open && !submitting.current) onClose() }}>
      <CenterMorphModalContent
        ariaLabel={t('subagent.defaultsTitle')}
        closeButtonLabel={t('subagent.cancel')}
        dismissible={!saving}
        showCloseButton={!saving}
        className="flex max-h-[min(36rem,calc(100vh-3rem))] max-w-2xl flex-col gap-5 p-5"
      >
        <div className="shrink-0 pr-10">
          <h2 className={FORM_PANEL_TITLE}>{t('subagent.defaultsTitle')}</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">{t('subagent.defaultsDesc', { name: profile.displayName })}</p>
        </div>
        <FadeScroll className="min-h-0 p-1">
          <div data-subagent-defaults-form data-form-items className="grid gap-5 md:grid-cols-2">
            {field(t('subagent.fieldModel'), (
              <div role="group" aria-labelledby={modelLabelId} className="w-fit max-w-full">
                <ModelPicker
                  models={models}
                  value={model}
                  thinkingLevel={thinking}
                  availableThinkingLevels={thinkingOptions}
                  onChange={item => setModel(`${item.providerId}/${item.id}`)}
                  onThinkingLevelChange={setThinking}
                  onInheritModel={() => setModel(null)}
                  onInheritThinking={() => setThinking(null)}
                  inheritLabel={t('subagent.defaultsParentModel')}
                  inheritThinkingLabel={t('subagent.notSet')}
                  unknownModelLabel={model ?? undefined}
                  textClassName="text-sm"
                  panelId="subagent-default-model-picker"
                  portal
                  disabled={saving || loadingModels}
                />
              </div>
            ), undefined, modelLabelId)}
            {field(t('subagent.fieldThinking'), (
              <Select value={thinking ?? 'default'} onValueChange={value => setThinking(value === 'default' ? null : value as ThinkingLevel)} disabled={saving}>
                <SelectTrigger className="h-9 text-sm" aria-label={t('subagent.fieldThinking')}><SelectValue /></SelectTrigger>
                <SelectContent portal>
                  <SelectItem value="default" className="text-sm">{t('subagent.notSet')}</SelectItem>
                  {THINKING_LEVELS.map(level => <SelectItem key={level} value={level} className="text-sm">{t(`thinking.${level}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            ), t('subagent.defaultsThinkingHint'))}
            {field(t('subagent.fieldInheritContext'), (
              <Checkbox checked={inheritContext} onCheckedChange={setInheritContext} disabled={saving} mark="square"
                label={t(inheritContext ? 'subagent.yes' : 'subagent.no')} aria-label={t('subagent.fieldInheritContext')} className="h-9 text-sm" />
            ))}
            {field(t('subagent.fieldRunInBackground'), (
              <Checkbox checked={runInBackground} onCheckedChange={setRunInBackground} disabled={saving} mark="square"
                label={t(runInBackground ? 'subagent.yes' : 'subagent.no')} aria-label={t('subagent.fieldRunInBackground')} className="h-9 text-sm" />
            ))}
          </div>
          {loadingModels ? <p className="mt-1.5 text-xs text-muted-foreground">{t('subagent.defaultsModelsLoading')}</p> : null}
          {model && !selectedModel && !loadingModels ? <p className="mt-1.5 break-all text-xs text-muted-foreground">{model}</p> : null}
          {modelsError ? (
            <div className="mt-1.5 flex items-center gap-2 text-xs text-destructive">
              <span>{t('subagent.defaultsModelsFailed')}</span>
              <Button variant="ghost" size="sm" onClick={() => setModelLoad(value => value + 1)}>{t('subagent.refresh')}</Button>
            </div>
          ) : null}
        </FadeScroll>
        {failed ? <p role="alert" className="text-xs text-destructive">{t('subagent.defaultsSaveFailed')}</p> : null}
        <div className="flex shrink-0 justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>{t('subagent.cancel')}</Button>
          <Button size="sm" data-subagent-defaults-save disabled={!dirty || saving} onClick={() => void save()}>{t('subagent.defaultsSave')}</Button>
        </div>
      </CenterMorphModalContent>
    </CenterMorphModal>
  )
}
