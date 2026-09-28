# Wheel gesture standard

`src/renderer/src/lib/wheel-gesture.ts` is the shared classifier for app-owned
wheel interactions. A macOS trackpad reports two deltas even when the intended
gesture is horizontal or vertical; their instantaneous sizes can cross during
a diagonal swipe or momentum. Reclassifying every event changes actions halfway
through a gesture.

- Choose the dominant axis and action on the first nonzero event. Retain both
  through the stream and its inertia; discard the other axis as noise.
- Start a fresh gesture after 200ms without wheel input. A modifier change also
  starts a fresh intent: Ctrl/pinch is vertical zoom, Shift maps wheel input to
  horizontal motion, including Chromium's already-mapped horizontal deltas.
- Normalize pixel/line/page units before applying motion. Page deltas use the
  viewport extent of their own axis. Browser annotation retains its existing
  40px line step when forwarding inverted pixel deltas to the guest.
- The trajectory maps vertical motion to zoom and horizontal motion to pan.
  Image previews keep trackpad swipes as pans, vertical notched wheels as zoom,
  and pinch as zoom; neither acceleration nor cross-axis noise changes intent.
  Pointer dragging remains free in both dimensions.
- `use-wheel-scroll.ts` supplies the policy to native file scroll surfaces,
  including nested Markdown/code/diff viewports. It finds the scrollport for
  the chosen axis, preserves same-axis chaining and overscroll containment,
  and yields to custom canvas handlers and browser/pinch shortcuts. It writes
  scroll position directly, leaving virtualization and saved-position ownership
  with their existing scroll listeners. Review diffs share the adapter.

Verification: `check-wheel-gesture.mjs` replays deterministic noisy streams and
modifier/unit cases. `check-present-trajectory-ui.mjs` drives diagonal native
wheel input, stable overview geometry and two-segment hover in both themes.
The media, table, PDF and browser UI suites exercise their own live handlers.
