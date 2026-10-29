import { useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Button } from '@/components/motion/button'
import { Checkbox } from '@/components/motion/checkbox'
import { Input } from '@/components/motion/input'
import { RadioGroup, RadioGroupItem } from '@/components/motion/radio'
import { Check, ChevronDown, ChevronUp, ChevronsDownUp, ChevronsUpDown, CircleHelp, Clock, PencilLine, X } from '@/lib/icons'
import { EASE_OUT } from '@/lib/ease'
import { useI18n } from '@/i18n'
import { askUserAnswerText } from '../../../../shared/ask-user'
import type { AskUserAnswer, AskUserToolDetails, PendingAskUserDTO } from '../../../../shared/ask-user'

/** A single-select pick slides to the next question after this beat; the last
 * question never auto-submits — submission belongs to an explicit confirm. */
const AUTO_ADVANCE_MS = 480

/** Directional question slide: the incoming question travels 14px along the
 * travel direction and fades in behind the outgoing one (which exits the
 * other way), so prev/next and the auto-advance each read as one continuous
 * motion instead of a hard swap. */
const SLIDE_DISTANCE_PX = 14
const questionVariants = {
  enter: (direction: number) => ({ opacity: 0, y: SLIDE_DISTANCE_PX * direction }),
  center: { opacity: 1, y: 0 },
  exit: (direction: number) => ({ opacity: 0, y: -SLIDE_DISTANCE_PX * direction })
}

/**
 * Seconds until main closes this question itself; null while no countdown runs
 * (no deadline configured, or the user has engaged and cancelled it for good).
 * The deadline lives in main — the panel only reads it down.
 */
function useCountdown(request: PendingAskUserDTO, engagedLocally: boolean): number | null {
  const active = (request.timeoutMs ?? 0) > 0 && request.engaged !== true && !engagedLocally
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, request.requestId])
  if (!active) return null
  return Math.max(0, Math.ceil((request.createdAt + (request.timeoutMs ?? 0) - now) / 1000))
}

/** `45s` / `2:05` — compact enough for the panel's own chrome row. */
function formatCountdown(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const rest = seconds % 60
  return `${Math.floor(seconds / 60)}:${String(rest).padStart(2, '0')}`
}

export type AskUserRespondPayload = { answers: AskUserAnswer[] } | { cancelled: true }

/**
 * The ask_user_question panel: one question set at a time, asked by a running
 * turn (or a subagent child in its parent's chat), answered here.
 *
 * Behaviour ported from pi-web's AskUserPanel onto beUI controls: one question
 * visible at a time with a header chip row for jumping between them, radios
 * auto-advance, checkboxes (multiSelect) wait for an explicit submit, every
 * question offers a free-text answer, and both Skip/Esc and the close button
 * dismiss the whole set without an error — the model is told the user did not
 * answer and continues on stated assumptions. A collapse button folds the
 * panel to a one-line row without settling anything, so the question can be
 * parked out of the way and reopened at any time.
 *
 * Every settle also lands in a LOCAL state (sent / cancelled), so the panel
 * shows what happened even if the IPC round trip never comes back — the panel
 * only unmounts when main republishes the pending list.
 */
export function AskUserPanel({
  request,
  onEngage,
  onRespond
}: {
  request: PendingAskUserDTO
  /**
   * The user did something real (picked, typed, navigated, expanded). Main ends
   * the auto-settle countdown on the first one and never restarts it —
   * collapsing deliberately does not report here.
   */
  onEngage: (requestId: string) => void
  onRespond: (requestId: string, payload: AskUserRespondPayload) => void
}) {
  const { t } = useI18n()
  const questions = request.questions
  const [qi, setQi] = useState(0)
  /** Per question: picked option indices. */
  const [answers, setAnswers] = useState<Record<number, number[]>>({})
  /** Per question: free-form answer. */
  const [custom, setCustom] = useState<Record<number, string>>({})
  /** Local settle feedback: null while the question is still open. */
  const [settled, setSettled] = useState<'sent' | 'cancelled' | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  /** Local copy of "the user engaged": hides the countdown before main republishes. */
  const [engagedLocally, setEngagedLocally] = useState(false)
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const optionBaseId = useId()
  /** Travel direction of the last question change (+1 forward), which the
   * slide animation follows so Back visually reverses Forward. */
  const [direction, setDirection] = useState(1)
  const reduceMotion = useReducedMotion()
  const slideTransition = reduceMotion ? { duration: 0 } : { duration: 0.25, ease: EASE_OUT }

  // A different question set in the same mount position starts from scratch:
  // main can publish set B before the renderer has processed set A's settle,
  // and a stale `settled`/`qi` would render the new set as already answered.
  const [activeId, setActiveId] = useState(request.requestId)
  if (activeId !== request.requestId) {
    setActiveId(request.requestId)
    setQi(0)
    setAnswers({})
    setCustom({})
    setSettled(null)
    setCollapsed(false)
    setEngagedLocally(false)
    setDirection(1)
  }

  const countdown = useCountdown(request, engagedLocally)

  const last = qi === questions.length - 1
  const selected = answers[qi] ?? []
  const hasAnswer = selected.length > 0 || Boolean(custom[qi]?.trim())

  useEffect(() => () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
  }, [])

  // Esc = dismiss the questions, Enter = advance/submit. Capture-phase on
  // window so the panel owns the keys before the composer's Esc-to-stop; a
  // focused text input keeps the input's own semantics (pi-web's split).
  const settledRef = useRef(false)
  settledRef.current = settled !== null
  const advanceRef = useRef<() => void>(() => {})
  advanceRef.current = () => {
    if (hasAnswer) advance()
  }
  const skipRef = useRef<() => void>(() => {})
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (settledRef.current) return
      const target = event.target as HTMLElement | null
      const inTextInput = target !== null
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (event.key === 'Escape' && !inTextInput) {
        event.preventDefault()
        event.stopPropagation()
        skipRef.current()
      }
      // A focused button keeps its own Enter activation (Skip / Continue /
      // option rows each carry their own meaning).
      if (event.key === 'Enter' && !inTextInput && target?.tagName !== 'BUTTON') {
        event.preventDefault()
        advanceRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
    // The refs above are refreshed every render, so one registration per
    // request is enough to always run the current handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.requestId])

  const goTo = (next: number) => {
    engage()
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    const clamped = Math.min(Math.max(next, 0), questions.length - 1)
    if (clamped === qi) return
    setDirection(clamped > qi ? 1 : -1)
    setQi(clamped)
  }

  const answerPayload = (): AskUserAnswer[] =>
    questions.map((question, index) => ({
      question: question.question,
      selected: (answers[index] ?? [])
        .map((optionIndex) => question.options[optionIndex]?.label)
        .filter((label): label is string => Boolean(label)),
      ...(custom[index]?.trim() ? { custom: custom[index]!.trim() } : {})
    }))

  const send = () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    setSettled('sent')
    onRespond(request.requestId, { answers: answerPayload() })
  }

  /** Report the first real interaction once; later ones are already covered. */
  const engage = () => {
    if (engagedLocally) return
    setEngagedLocally(true)
    onEngage(request.requestId)
  }

  const advance = () => {
    if (last) send()
    else goTo(qi + 1)
  }

  /** Skip / Esc / close: settle the model's call as a dismissal and say so. */
  const skip = () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    setSettled('cancelled')
    onRespond(request.requestId, { cancelled: true })
  }
  skipRef.current = skip

  const toggle = (index: number) => {
    engage()
    const multi = questions[qi]!.multiSelect === true
    setAnswers((current) => {
      const picked = current[qi] ?? []
      const next = !multi
        ? [index]
        : picked.includes(index)
          ? picked.filter((item) => item !== index)
          : [...picked, index]
      return { ...current, [qi]: next }
    })
    if (!multi) {
      // Free text and a single pick are mutually exclusive answers; a
      // multi-select keeps both (pi-web semantics).
      setCustom((current) => ({ ...current, [qi]: '' }))
      if (!last) {
        if (advanceTimer.current) clearTimeout(advanceTimer.current)
        advanceTimer.current = setTimeout(() => {
          setDirection(1)
          setQi((current) => Math.min(questions.length - 1, current + 1))
        }, AUTO_ADVANCE_MS)
      }
    }
  }

  const stateAttr = settled ?? (collapsed ? 'collapsed' : 'open')

  // Collapsed: one quiet line that names the question and keeps every action
  // reachable — reopen, or close it unanswered.
  if (collapsed && settled === null) {
    return (
      <div className="px-3 pb-2" data-ask-user={request.requestId} data-ask-user-state={stateAttr}>
        <div className="mx-auto w-full max-w-3xl">
          <div className="flex items-center gap-1.5 rounded-control border border-border bg-card py-1 pl-2.5 pr-1 shadow-overlay">
            <CircleHelp aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
              {questions[qi]!.question}
            </span>
            <span className="shrink-0 text-caption tabular-nums text-muted-foreground">
              {qi + 1} / {questions.length}
            </span>
            <Button
              variant="ghost"
              size="icon"
              data-ask-user-action="expand"
              aria-label={t('askUser.expand')}
              title={t('askUser.expand')}
              className="size-6"
              onClick={() => { engage(); setCollapsed(false) }}
            >
              <ChevronsUpDown aria-hidden="true" className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              data-ask-user-action="close"
              aria-label={t('askUser.close')}
              title={t('askUser.close')}
              className="size-6 text-muted-foreground"
              onClick={skip}
            >
              <X aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Settled locally: a quiet chip in the panel's own place, kept until main's
  // republished pending list unmounts the panel.
  if (settled === 'sent' || settled === 'cancelled') {
    const sent = settled === 'sent'
    return (
      <div className="px-3 pb-2" data-ask-user={request.requestId} data-ask-user-state={stateAttr}>
        <div className="mx-auto w-full max-w-3xl">
          <span
            data-ask-user-action="settled"
            className={
              sent
                ? 'inline-flex items-center gap-1.5 rounded-control bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400'
                : 'inline-flex items-center gap-1.5 rounded-control bg-muted px-2.5 py-1.5 text-xs font-semibold text-muted-foreground'
            }
          >
            {sent ? <Check aria-hidden="true" className="size-3.5" /> : <X aria-hidden="true" className="size-3.5" />}
            {sent ? t('askUser.sentMessage') : t('askUser.skippedMessage')}
          </span>
        </div>
      </div>
    )
  }

  const question = questions[qi]!
  const sourceBadge = request.source?.kind === 'subagent' ? (
    <span className="rounded-control border border-border bg-muted px-1.5 py-0.5 text-caption font-semibold text-muted-foreground">
      {request.source.profile
        ? t('askUser.sourceSubagentNamed', { profile: request.source.profile })
        : t('askUser.sourceSubagent')}
    </span>
  ) : null

  return (
    <div className="px-3 pb-2" data-ask-user={request.requestId} data-ask-user-state={stateAttr}>
      <div className="mx-auto w-full max-w-3xl">
      <div className="relative rounded-card border border-border bg-card p-4 shadow-overlay">
        <div className="absolute right-2.5 top-2.5 flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            data-ask-user-action="collapse"
            aria-label={t('askUser.collapse')}
            title={t('askUser.collapse')}
            className="size-7 text-muted-foreground"
            onClick={() => setCollapsed(true)}
          >
            <ChevronsDownUp aria-hidden="true" className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-ask-user-action="close"
            aria-label={t('askUser.close')}
            title={t('askUser.close')}
            className="size-7 text-muted-foreground"
            onClick={skip}
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>

        <div className="mb-2 flex items-center gap-1.5 pr-16 text-xs font-semibold text-muted-foreground">
          <CircleHelp aria-hidden="true" className="size-3.5" />
          <span>{t('askUser.kicker')}</span>
          {sourceBadge}
          {/* The auto-settle deadline is main's; the panel only reads it down,
              and any real interaction takes it away for good. */}
          {countdown !== null ? (
            <span
              data-ask-user-countdown={countdown}
              className="ml-auto inline-flex shrink-0 items-center gap-1 text-caption font-medium tabular-nums text-muted-foreground/70"
            >
              <Clock aria-hidden="true" className="size-3" />
              {t('askUser.countdown', { time: formatCountdown(countdown) })}
            </span>
          ) : null}
        </div>

        {/* Each question's own `header` — the short label the model supplies —
            is the chip row's tab label, falling back to its ordinal. It is
            both the only place that label is ever shown and the fastest way
            between questions of a long set. */}
        {questions.length > 1 ? (
          <div className="mb-2.5 flex flex-wrap items-center gap-1" data-ask-user-chips="">
            {questions.map((item, index) => (
              <Button
                key={`${index}:${item.question}`}
                variant={index === qi ? 'secondary' : 'ghost'}
                size="sm"
                data-ask-user-chip={index}
                aria-current={index === qi ? 'true' : undefined}
                aria-label={item.header ?? `${index + 1}`}
                className={`h-6 min-w-0 max-w-40 gap-1 px-2 text-caption font-semibold ${index === qi ? 'bg-muted' : ''}`}
                onClick={() => goTo(index)}
              >
                {answers[index]?.length || custom[index]?.trim() ? (
                  <Check aria-hidden="true" className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : null}
                <span className="truncate">{item.header ?? `${index + 1}`}</span>
              </Button>
            ))}
          </div>
        ) : null}

        {/* The `layout` wrapper smooths the card's height as questions of
            different lengths trade places (popLayout floats the exiting
            question out of the flow, so the box would otherwise jump). */}
        <motion.div layout transition={slideTransition}>
          <AnimatePresence initial={false} custom={direction} mode="popLayout">
            <motion.div
              key={qi}
              custom={direction}
              variants={questionVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={slideTransition}
            >
              <p className="mb-3 pr-7 text-sm font-semibold leading-ui-loose text-foreground">
                {question.question}
              </p>

              <div className="flex flex-col gap-1.5">
                {question.multiSelect === true ? (
                  question.options.map((option, index) => (
                    <OptionRow key={`${qi}:${index}`} index={index} description={option.description} controlId={`${optionBaseId}-${qi}-${index}`}>
                      <Checkbox
                        id={`${optionBaseId}-${qi}-${index}`}
                        checked={selected.includes(index)}
                        onCheckedChange={() => toggle(index)}
                        label={option.label}
                        aria-label={option.label}
                      />
                    </OptionRow>
                  ))
                ) : (
                  <RadioGroup
                    value={selected[0] !== undefined ? String(selected[0]) : ''}
                    onValueChange={(value) => toggle(Number(value))}
                    className="gap-1.5"
                  >
                    {question.options.map((option, index) => (
                      <OptionRow key={`${qi}:${index}`} index={index} description={option.description} controlId={`${optionBaseId}-${qi}-${index}`}>
                        <RadioGroupItem id={`${optionBaseId}-${qi}-${index}`} value={String(index)} label={option.label} />
                      </OptionRow>
                    ))}
                  </RadioGroup>
                )}
                <div className="pt-1 pl-1">
                  <Input
                    value={custom[qi] ?? ''}
                    onChange={(value) => {
                      engage()
                      setCustom((current) => ({ ...current, [qi]: value }))
                      if (question.multiSelect !== true) setAnswers((current) => ({ ...current, [qi]: [] }))
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && hasAnswer) {
                        event.preventDefault()
                        advance()
                      }
                    }}
                    placeholder={t('askUser.customPlaceholder')}
                    aria-label={t('askUser.customPlaceholder')}
                    leftIcon={<PencilLine aria-hidden="true" className="size-3.5" />}
                    className="border-0 bg-transparent p-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                    // The field keeps the input's shared
                    // icon-aware left padding — a blanket `px-*` put the
                    // placeholder under the pencil glyph.
                    classNames={{
                      field: 'rounded-control bg-muted/50'
                    }}
                  />
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        </motion.div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-2.5">
          <div className="flex items-center gap-1 text-muted-foreground">
            <Button
              variant="ghost"
              size="icon"
              data-ask-user-action="prev"
              aria-label={t('askUser.prevQuestion')}
              disabled={qi <= 0}
              className="size-7"
              onClick={() => goTo(qi - 1)}
            >
              <ChevronUp aria-hidden="true" className="size-4" />
            </Button>
            <span className="min-w-[3ch] text-center text-xs font-semibold tabular-nums">
              {qi + 1} / {questions.length}
            </span>
            <Button
              variant="ghost"
              size="icon"
              data-ask-user-action="next"
              aria-label={t('askUser.nextQuestion')}
              disabled={last}
              className="size-7"
              onClick={() => goTo(qi + 1)}
            >
              <ChevronDown aria-hidden="true" className="size-4" />
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" data-ask-user-action="skip" onClick={skip}>
              {t('askUser.skip')}
            </Button>
            <Button variant="primary" size="sm" data-ask-user-action="submit" disabled={!hasAnswer} onClick={advance}>
              {last ? t('askUser.send') : t('askUser.continue')}
            </Button>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}

/**
 * The transcript's Q&A card: what the tool asked and what the user answered,
 * rendered as the ask_user_question row's body once the call settles. A
 * dismissal is shown honestly — a badge plus the unanswered questions, never
 * a fabricated answer set.
 */
export function AskUserResultCard({ details }: { details: AskUserToolDetails }) {
  const { t } = useI18n()
  const pending = details.status === 'pending'
  /** Receipt (async dispatch), timeout, dismissal, or nothing when answered. */
  const statusLabel = pending
    ? t('askUser.asyncPending')
    : details.reason === 'timeout'
      ? t('askUser.timedOut')
      : details.status === 'cancelled'
        ? t('askUser.cancelled')
        : null
  return (
    <div
      className="flex min-w-0 flex-col gap-2 py-1"
      data-ask-user-result={details.status}
      data-ask-user-reason={details.reason ?? (pending ? 'pending' : 'answered')}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">{t('askUser.resultTitle')}</span>
        {details.mode === 'async' ? (
          <span className="rounded-control border border-border px-1.5 py-0.5 text-caption font-semibold text-muted-foreground">
            {t('askUser.asyncBadge')}
          </span>
        ) : null}
        {statusLabel ? (
          <span
            data-ask-user-status={pending ? 'pending' : details.reason ?? 'dismissed'}
            className="rounded-control bg-muted px-1.5 py-0.5 text-caption font-semibold text-muted-foreground"
          >
            {statusLabel}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-2.5">
        {details.questions.map((question, index) => {
          // An async receipt has no answers yet: listing them as unanswered
          // would claim the user skipped something they never saw.
          if (pending) {
            return (
              <span key={`${index}:${question.question}`} className="text-sm leading-ui-loose text-muted-foreground">
                {index + 1}. {question.question}
              </span>
            )
          }
          const text = askUserAnswerText(details.answers?.[index])
          return (
            <div key={`${index}:${question.question}`} className="flex flex-col gap-0.5">
              <span className="text-sm font-medium leading-ui-loose text-foreground">
                {index + 1}. {question.question}
              </span>
              {text !== null ? (
                <span className="flex items-start gap-1.5 pl-1">
                  <Check aria-hidden="true" className="mt-1 size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-sm leading-ui-loose text-muted-foreground">{text}</span>
                </span>
              ) : (
                <span className="pl-1 text-sm italic leading-ui-loose text-muted-foreground/80">
                  {t('askUser.noAnswer')}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * An option's clickable footprint: the beUI control plus, when the option has
 * a description, a second `<label htmlFor>` row pointing at the same control —
 * valid HTML (one control, several labels) that keeps the explanation inside
 * the click target without rebuilding the control's own chrome.
 *
 * The wrapper is a flex COLUMN, never a bare block: the vendored control's
 * label is an `inline-flex` whose baseline moves when its mark appears (the
 * mark becomes the flex container's baseline source), and inside a block that
 * baseline feeds the parent's line box — so a selected option's row grew by
 * ~4px and every row below it shifted. A flex item has no line box to
 * perturb, so the row is exactly the control's own height in both states.
 */
function OptionRow({
  index,
  description,
  controlId,
  children
}: {
  index: number
  description?: string
  controlId: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col" data-ask-user-option={index}>
      {children}
      {description ? (
        <label htmlFor={controlId} className="pl-[26px] cursor-pointer select-none text-xs leading-snug text-muted-foreground">
          {description}
        </label>
      ) : null}
    </div>
  )
}
