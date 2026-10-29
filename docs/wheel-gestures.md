# Wheel gesture standard

`src/renderer/src/lib/wheel-gesture.ts` normalizes app-owned wheel input.
Ordinary scrolling preserves both deltas, including diagonal swipes, momentum
and changes of direction. No dominant axis is selected or held across events.

- Apply horizontal and vertical motion independently on every event. Direction
  changes do not require an idle gap.
- Shift explicitly maps wheel input to horizontal motion, including Chromium's
  already-mapped horizontal deltas. Pinch keeps its vertical zoom delta.
- Normalize pixel/line/page units before applying motion. Page deltas use the
  viewport extent of their own axis. Browser annotation retains its existing
  40px line step when forwarding inverted pixel deltas to the guest.
- Image previews pan both axes together for trackpad swipes. Retain pan mode
  through accelerating momentum so it cannot become mouse-wheel zoom; a 200ms
  idle gap releases this input classification. Horizontal/diagonal input always
  permits pan, including immediately after zoom. Vertical notched wheels and
  pinch zoom. Pointer dragging remains free in both dimensions.
- `use-wheel-scroll.ts` supplies the policy to native file scroll surfaces,
  including nested Markdown/code/diff viewports and the Git graph. It finds
  each axis's scrollport independently, preserving chaining and containment,
  and yields to custom canvas handlers and browser/pinch shortcuts. It writes
  scroll position directly, leaving virtualization and saved-position ownership
  with their existing scroll listeners. Review diffs share the adapter.

Verification: `check-wheel-gesture.mjs` checks diagonal streams, direction
reversals and modifier/unit cases. `check-present-trajectory-ui.mjs` checks
diagonal wheel input in tool-call links and nested list scrolling. The Rewind, media,
table, PDF and browser UI suites exercise both axes in their live handlers.
