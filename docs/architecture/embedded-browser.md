# Embedded browser

The right-rail browser and `browser_*` tools drive the same renderer-owned Electron webview. `src/main/browser/service.ts` is the single main-process owner; playwright-core connects to the app's loopback CDP endpoint. Shared persistent partition `persist:pith-browser` carries login state, disclosed by the human-only first-use consent. Browser tools cannot grant their own consent.

## Page ownership and hosting

Owners are human or `agent:<SDK session ID>`. Agent tools resolve only owned pages; disposal/deletion closes them, ordinary run Stop preserves them across turns. Renderer reports native interactions to invalidate stale snapshots. State notifications are coalesced and never carry transcript eventSequence.

Electron cannot create these guests through CDP Target.createTarget. Main queues a pending marker-page request; Workspace opens the host for agent requests; renderer mounts the webview and reports browser:seen. Reconcile discovers the marker and completes registration/navigation. Handshake retry/state-only fallback covers missed mount events and guests born before CDP discovery. Restored rows ensure service connection before spawning; bounded marker re-handshake/remount repairs dead guests.

Close by registry removal and renderer unmount, never Playwright page.close. Closing an unregistered row cancels its pending creation without retrying; retired IDs reject late seen reports and marker discovery. Explicit browser rail-tab closure also closes its known registered/pending pages, preventing an abandoned handshake from rebuilding them on reopen. Selected guests are visible. Hidden agent guests retain full size with opacity zero/pointer-events none; display:none makes automation unreliable. Hidden human pages may display:none. Explicit element sizing follows pane/device viewport; no CDP device-metrics emulation.

Rail tab switches keep browser mounted. Collapsing the rail normally destroys guests and restores bounded saved pages on reopen; the optional keep-alive preference retains the mounted guest layer. Settings → Browser separately offers “Restore tabs after closing the browser” (localStorage, default on): disabling it clears the snapshot on explicit browser rail-tab closure, including close-other/close-all actions, so reopening starts with one blank page. Opening a closed browser also applies the preference, covering changes made while it was already closed. Folding and expanding always retain the snapshot independently of this preference. Explicit closure invalidates outgoing snapshot writers and pending restore callbacks before teardown; closing the final page clears the snapshot even when restoration is enabled. Restored pages preserve owner and saved destination/title, spawn in staggered order and must not suppress restoration based on stale status.

## Electron invariants

- Append the CDP switches before app ready, bind loopback, and use one effective port source. `PITH_CDP_PORT` supports isolated checks; local processes can access the endpoint.
- Reload uses goto(current URL), never CDP Page.reload, which can kill a guest or target the shell.
- Text input uses real keyboard events/pressSequentially, never fill/Input.insertText on hidden guests.
- Synthetic wheel is verified against position and falls back to scrollBy only when not consumed; do not double-scroll.
- Screenshots have explicit bounded timeout/retry; page evaluation uses one budgeted helper, with shorter pure-measurement deadlines and distinct timeout/error results.
- Dispose drops handles/state; Browser.close/context.close would quit the whole app and are forbidden.
- Playwright's default media emulation must be cleared through its API and current theme replayed on every registration. Arbitrary shell/popups/external targets never enter the marker registry.

`wiring.ts` allows window-shaped web popups as real BrowserWindows with shared partition/opener and opener-owned cleanup. Tab-shaped popups become panel rows. External pages have no Node/app preload, use context isolation/sandbox and an explicit permission allowlist; non-browser shell links retain their separate handling.

## Tool and trust contract

Fourteen tools are registered independent of the live enablement switch: navigate/pages/focus/snapshot/click/hover/select/type/press_key/scroll/wait_for/screenshot/close/upload. Active lists, catalog, icons and categories must agree. Reload reapplies the active set; subagent access follows frozen ceilings. Tool output is model-facing English, not renderer locale.

Page text, titles, errors and console text stay inside `<<<untrusted-web-content>>>`; app-generated diagnostics remain outside. Snapshots default to 20k characters, hard cap 200k, with offset/nextOffset paging. Diff baseline is the visible delivered window, never undisclosed full content. Snapshot selector is main-frame scoped; action selectors inspect a bounded frame set and reject ambiguity.

Targets use one of ref/selector/ax. Refs must be present in the latest active-page allowlist; page navigation, owner focus or human interaction can invalidate them. Ref strings are not generation tokens. AX click/hover supports closed shadow roots through accessibility/backend node geometry and real pointer dispatch, with hit testing before any event; AX does not add closed-root typing/select/upload.

Actions settle before snapshot within a bounded navigation/mutation budget. No-change diagnostics require both measured zero mutation and unchanged delivered text; missing measurements do not fabricate certainty. Wait delay and condition timeout are separate; unmet conditions return explicit observations. Scroll/focus/empty-tree measurements explain actions invisible to accessibility text.

Upload validates existing regular files, at most 20, then uses input.setInputFiles or intercepted filechooser. Paths currently may be outside cwd; browser upload is not narrowed by the file sandbox. Click's short filechooser interception catches accidental upload clicks but temporarily also intercepts a human picker on the same page. Type has an 8000-character cap. Never silently pretend either limitation is absent.

## Human browser controls

beUI/i18n chrome provides navigation, URL, find, zoom, history, device sizing, downloads and clear-data confirmation. Reapply zoom at every dom-ready independently of handshake. Find-next requests serialize with bounded retries; preserve Chromium ordinal semantics. True popups keep opener login protocols and never become model pages.

The new-page handshake may complete after its row appears. User tab selection, closing the selected tab and later new-page requests supersede that receipt's automatic selection; a late receipt must not pull focus away from the chosen tab.

Human address-bar and start-page input share `resolveBrowserInput`: domains, local development addresses and explicit allowed URLs navigate directly; other text opens the selected search provider with an encoded query. Domain classification uses tldts's Public Suffix List and special-use/IP detection, followed by the standard URL parser; search operators remain queries and a leading `?` forces search for ambiguous input. Settings → Browser selects Google (default), Bing, DuckDuckGo or Baidu, persisted in AppSettings and broadcast to mounted inputs. Agent navigation retains URL-only semantics and the HTTP/HTTPS/about:blank allowlist still applies.

Each guest tracks progress once per main-document navigation through `did-start-navigation`, ignoring subframes and in-page changes. Blank pages and registration markers never show progress; later iframe loading cannot restart a completed document's bar. Reloads start a fresh estimate and server redirects share the active one. A thin, pointer-transparent beUI progress track overlays the top of the page viewport without taking layout space. Navigation commit and DOM readiness advance the estimate, bounded below completion until `did-stop-loading`; main-frame failures and guest teardown clear it. Timers are disposed on guest remount/unmount, and progress transitions respect app and system reduced motion.

Annotation retains an input-capture overlay through selection. Resolve current elements via guest executeJavaScript, not a stale service document. Forward both wheel axes using shared pixel conversion and Electron sign inversion; pointer geometry uses the webview rect. Submission inserts structured annotation data into the composer draft.

## Chrome cookie import

Settings → Browser supports Chrome profile import on macOS. `src/main/browser/import-cookies.ts` stages the SQLite database and WAL, obtains the Chrome Safe Storage passphrase through Keychain, decrypts supported v10/v11 values and verifies any SHA-256 host binding. Convert WebKit microsecond timestamps in SQL; preserve secure-cookie prefix rules. Unsupported or malformed values are skipped.

Only main reads or decrypts cookie values; IPC exposes counts and error codes. Discovery distinguishes a blocked Chrome directory from absent profiles and offers Full Disk Access guidance for the launching terminal in development or the installed app. `<userData>/browser-import.json` records only successfully applied identities; clearing an import removes those cookies rather than all browser data.

## Verification

```sh
node scripts/check-browser.mjs
node scripts/check-browser-ui.mjs
node scripts/check-browser-import.mjs
node scripts/check-codemode-contracts.mjs
```

UI checks require a build and isolate browser profile/ports. They cover guest creation/close/visibility, popup/session ownership, consent, navigation/search/provider persistence, loading progress without layout shifts, find/zoom/theme, restoration/keep-alive, annotation and upload. Preserve live-vs-source assertion distinctions; mock/protocol coverage is not arbitrary live-site compatibility.
