import { Loader } from '@/components/motion/loader'
import { TextScramble } from '@/components/motion/text-scramble'
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
 * Code style status sentence matched to the step that is running; the dot-matrix
 * loader marks the accent while it does, the sentence's gradient flows, and a
 * new sentence resolves through beUI's `TextScramble`. Off, the row is exactly
 * what it always was: the plain spinner with only a screen-reader label.
 *
 * The loader is deliberately `dot-matrix` rather than `morph`: the morph
 * variant animates an SVG path's `d` every frame (uncacheable, non-composited
 * raster work), which showed up as dropped frames next to the sweep, while the
 * dot matrix is nine tiny circles animating `opacity`/`scale` only.
 */
export function TurnStatus({ className, step = THINKING_STEP, seedKey = 'live' }: TurnStatusProps) {
  const { t, locale } = useI18n()
  const [verbsEnabled] = useSpinnerVerbs()
  const verb = useLiveSpinnerVerb(verbsEnabled, step, seedKey)

  return (
    // `data-spinner-verb` names the sentence this row is playing and
    // `data-spinner-loader` the loader drawing it: the stable hooks
    // `scripts/check-spinner-verbs.mjs` reads, like `data-todo-progress` for the
    // task list (the vendored `TextScramble` takes no extra props).
    <div
      className={cn('flex h-6 items-center gap-2', className)}
      data-spinner-verb={verb?.id}
      data-spinner-loader={verb ? 'dot-matrix' : 'spinner'}
    >
      <Loader
        variant={verb ? 'dot-matrix' : 'spinner'}
        // `size-4` — the same square as the transcript's tool glyphs.
        size={16}
        label={t('chat.working')}
        className="shrink-0 text-primary"
      />
      {verb ? (
        // Deliberately NOT keyed by verb id: `TextScramble` animates on a `text`
        // change itself, and a remount would take its first-render path and
        // paint the new sentence outright. It also carries the final value in
        // its own `sr-only` span, so the scrambled glyphs never reach the
        // accessibility tree — the row still announces the sentence it is
        // playing, not the noise it is transitioning through.
        <TextScramble
          text={spinnerVerbLabel(verb, locale)}
          // Body text size (`text-sm leading-6`, exactly the transcript's own
          // body copy) and the flow sweep defined in styles.css.
          className="spinner-verb-flow min-w-0 truncate text-sm leading-6"
        />
      ) : null}
    </div>
  )
}
