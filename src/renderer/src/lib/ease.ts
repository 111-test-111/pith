// Shared motion tokens. Easing curves mirror the CSS custom properties in
// globals.css; springs are the canonical physics used across components.
// Strong custom variants — defaults like `ease-in`/`ease-out` feel weak.

import type { Transition } from "motion/react";

export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const;

/** CSS string form of EASE_OUT for inline style transitions. */
export const EASE_OUT_CSS = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Press feedback on buttons and other tappable surfaces. */
export const SPRING_PRESS = {
  type: "spring",
  stiffness: 500,
  damping: 30,
  mass: 0.6,
} as const;

/** Content swaps — label/icon slots trading places inside a control. */
export const SPRING_SWAP = {
  type: "spring",
  stiffness: 460,
  damping: 30,
  mass: 0.55,
} as const;

/** Small state marks. Floating-surface entrances live in overlay-motion.ts. */
export const SPRING_PANEL = {
  type: "spring",
  stiffness: 420,
  damping: 40,
  mass: 0.5,
} as const;

/** Shared-layout glides — pills, indicators and panels morphing between positions. */
export const SPRING_LAYOUT = {
  type: "spring",
  stiffness: 360,
  damping: 32,
  mass: 0.6,
} as const;

/** Cursor-follow physics for decorative mouse tracking (magnetic, tilt, dock). */
export const SPRING_MOUSE = {
  stiffness: 200,
  damping: 15,
  mass: 0.3,
} as const;

/** Dragged handles and fills (sliders) — critically damped `useSpring` config,
 * so the value follows the pointer butterily and never rebounds off an end. */
export const SPRING_GLIDE = {
  stiffness: 700,
  damping: 50,
  mass: 0.5,
} as const;

// ── local patch (pi-app): content timing scale + reduced-motion helper ───────
//
// Overshoot budget: the springs above fall into two camps, whether or not their
// damping was chosen deliberately. ζ = damping / (2·√(stiffness·mass)):
//   SPRING_PANEL  ζ≈1.38   no overshoot
//   SPRING_LAYOUT ζ≈1.09   no overshoot
//   SPRING_SWAP   ζ≈0.94   ~0.4% overshoot
//   SPRING_PRESS  ζ≈0.87   ~0.5% overshoot
//   MESSAGE_POP_UP (message.tsx) ζ≈0.93  ~4% overshoot
//   BUBBLE_POP     (message-bubble.tsx) ζ≈0.82  ~10% overshoot
//
// Rule: overshoot is a *control* affordance. It is allowed only on small,
// discrete, user-initiated elements — buttons, icon/label swaps, one sent
// bubble. Content must never overshoot: it can be large and can be inserted
// many times a second by a fast model, where a 4% scale wobble on a whole turn
// reads as jitter. `MESSAGE_POP_UP` is the single active transcript exception
// (`BUBBLE_POP` only runs when `MessageBubble.animateIn` is enabled, which the
// app currently never does), and it runs only on the optimistic user bubble.
// Every other thing that appears in the transcript goes through `RowReveal`
// (components/app/RowReveal.tsx): opacity only, no transform, no layout
// animation.

/**
 * Content duration scale. Use `fast` for rows/notices appearing in the
 * transcript, `base` for disclosures and completion-action rows, `slow` for
 * longer content changes. Floating surfaces use overlay-motion.ts instead.
 */
export const DURATION = {
  fast: 0.15,
  base: 0.22,
  slow: 0.32,
} as const;

/**
 * Collapse a transition to an instant state when the user prefers reduced
 * motion — springs and transforms must not run at all in that mode. Pass a
 * `reduced` fallback when the caller only animates opacity and a 0-duration
 * hop would be jarring.
 */
export function motionTransition(
  reduce: boolean | null | undefined,
  transition: Transition,
  reduced: Transition = { duration: 0 },
): Transition {
  return reduce ? reduced : transition;
}
