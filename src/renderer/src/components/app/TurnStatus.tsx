import { RunningLoader } from './RunningLoader'
import { TextShimmer } from '@/components/motion/text-shimmer'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  THINKING_STEP,
  spinnerVerbLabel,
  useLiveSpinnerVerb,
  useSpinnerVerbs,
  type SpinnerStepContext
} from '@/lib/spinner-verbs'

export interface TurnStatusProps {
  className?: string
  /**
   * True when the turn is suspended on a pending ask_user_question: the row
   * then plays a fixed localized "waiting for your answer" sentence instead
   * of a rotating verb — this is the turn's actual state, not flavor text, so
   * it renders even with spinner verbs switched off.
   */
  waitingUser?: boolean
  /**
   * Frontier step of the live turn — reasoning, or the kind of tool call that
   * is running — which selects the verb pool. Defaults to the thinking pool,
   * the honest answer while no round has produced a part yet.
   */
  step?: SpinnerStepContext
  /**
   * Stable identity for the verb hash (the session). Every waiting row of one
   * session shares it, so the sentence a user is reading never flips when the
   * row moves from the transcript's pending slot into the live turn.
   */
  seedKey?: string
}

/**
 * The one "turn in progress" indicator: a single spinner row, strictly one line
 * tall, always rendered below the turn's output. It replaces the earlier
 * per-phase text shimmers ("Thinking…", "Working…", "…") and the elapsed-time
 * label, which could surface mid-round — above the tool calls that same round
 * emitted.
 *
 * With spinner verbs on (Settings → General, default) the row plays a Claude
 * Code style status sentence matched to the step that is running; loader and
 * sentence both wear the theme accent — the dither particles are drawn in
 * `currentColor` (the row passes `text-primary`) and the sentence's beUI
 * `TextShimmer` is tinted to the same accent — and the sentence keeps the
 * component's own reduced-motion reset. Off, the row is exactly what it always
 * was: the plain spinner with only a screen-reader label.
 *
 * The loader is deliberately beUI's own art and not `morph` (an SVG path's `d`
 * every frame is uncacheable, non-composited raster work): `dither-plus` is the
 * registry's `dither` — `opacity` on fixed grid cells — with the four corner
 * particles of its 4×4 Bayer matrix dropped, so the row keeps one loader
 * component with its `role=status` wiring and reduced-motion contract.
 */
export function TurnStatus({ className, waitingUser = false, step = THINKING_STEP, seedKey = 'live' }: TurnStatusProps) {
  const { t, locale } = useI18n()
  const [verbsEnabled] = useSpinnerVerbs()
  const verb = useLiveSpinnerVerb(verbsEnabled, step, seedKey)
  const label = waitingUser ? t('askUser.waiting') : verb ? spinnerVerbLabel(verb, locale) : null

  return (
    // `data-spinner-verb` names the sentence this row is playing and
    // `data-spinner-loader` the loader drawing it: the stable hooks
    // `scripts/check-spinner-verbs.mjs` reads, like `data-todo-progress` for the
    // task list.
    <div
      // One row height for the transcript (see `lib/transcript-rhythm`): the
      // waiting row is the same box as the rows above it, with its own line
      // centred. The persistent waiting row always keeps a roomy leading gap.
      className={cn('transcript-row flex items-center gap-2', className)}
      data-row="process"
      data-transcript-gap-before="roomy"
      data-spinner-waiting-user={waitingUser ? 'true' : undefined}
      data-spinner-verb={verb?.id}
      data-spinner-loader={verb ? 'dither-plus' : 'spinner'}
    >
      <RunningLoader
        variant={verb ? 'dither-plus' : 'spinner'}
        // `size-4` — the same square as the transcript's tool glyphs.
        size={16}
        label={t('chat.working')}
        className="shrink-0 text-primary"
      />
      {label ? (
        // beUI's own text animation: a gradient sweep across the sentence, 2s a
        // pass and infinite, with the keyframes and the reduced-motion reset
        // travelling inside the component. App glue adds the waiting row's
        // geometry (one line, ellipsised in a narrow pane, body size) and
        // re-tints the one thing that is not the theme's: the vendored default
        // runs `muted-foreground` → `foreground`, and this row wears the accent.
        // tailwind-merge drops the vendored gradient for this arbitrary value.
        <TextShimmer
          duration={2}
          className="transcript-label min-w-0 truncate whitespace-pre text-sm leading-ui-loose bg-[linear-gradient(110deg,color-mix(in_oklch,var(--primary)_40%,transparent)_25%,var(--primary)_50%,color-mix(in_oklch,var(--primary)_40%,transparent)_75%)]"
        >
          {label}
        </TextShimmer>
      ) : null}
    </div>
  )
}
