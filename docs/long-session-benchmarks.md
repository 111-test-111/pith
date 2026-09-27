# Long-session benchmarks

`scripts/benchmark-long-session.mjs` measures fixed, offline conversations through real SDK, store, SQLite worker and Electron renderer code. It uses existing esbuild, Vite and Playwright dependencies; no API key, model request, user session or new test framework is involved.

## Run and compare

Build the app first because the Electron fixture uses the shipped preload:

```sh
npm run typecheck && npm run build
node scripts/check-long-session-benchmark.mjs
node scripts/benchmark-long-session.mjs --output=baseline.json
node scripts/benchmark-long-session.mjs --baseline=baseline.json --output=current.json
```

The default is **100 user turns, three samples**. Each sample has a fresh Node process, Electron process, profile, JSONL file and database. The larger scales are explicit:

```sh
node scripts/benchmark-long-session.mjs --full --output=full.json
node scripts/benchmark-long-session.mjs --sizes=1000,10000 --samples=1 --output=large-smoke.json
node scripts/benchmark-long-session.mjs --baseline=baseline.json --max-regression=1.5 --min-delta-ms=5
```

`--full` selects 100 / 1,000 / 10,000 turns. `--samples` accepts 1–10; a single sample is useful for smoke coverage, not a stable performance baseline. `--timeout-ms` defaults to 180,000 per Node/Electron sample and accepts 1,000–600,000. Subprocesses and owned fixture directories are cleaned after success and failure. Full runs retain all completed raw measurements in one JSON report and can consume substantial memory because the current transcript retains all turn DOM.

JSON is the only stdout output. Progress and build diagnostics go to stderr. `--output` also writes exactly that JSON to a file. The report contains schema/workload versions, timestamps, app and SDK versions, Git commit/dirty state, machine/OS/Node identity, Electron/Chromium versions, workload fingerprint, configuration, raw samples, metric min/median/p95/max, dimension checks, memory endpoints and the comparison verdict. Failed cases keep their completed Node phase and available partial renderer measurements in `partialSamples`; timeout failures name the active stage, and `complete: false` never passes as a full sample. The p95 is an empirical order statistic; with three samples it is simply the maximum.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Measurements and bounds pass; baseline comparison passes when supplied |
| 1 | At least one compared metric regressed |
| 2 | Invalid options or incompatible/malformed baseline |
| 3 | Measurement/setup failure, timeout or deterministic bound violation |

Comparisons require the same input fingerprint, workload/schema versions, scale, machine/OS/Node, SDK, Electron/Chromium, production build mode, viewport and motion/appearance configuration. Changing app code/Git revision is expected. A timing metric fails only when its **median ratio exceeds the configured ratio and its absolute increase reaches the noise floor**. The default ratio is 1.5 and the noise floor is 5 ms. This is a configurable same-machine regression policy, not a universal wall-clock SLA. Missing or mismatched metrics are errors, never silently skipped. The current baseline comparison concerns timing; memory and DOM measurements remain visible for review alongside independent dimension bounds.

Run baseline and current serially on the same otherwise idle machine with the same sample count. OS file caches are not cleared, so “fresh process” must not be interpreted as cold disk. Reports made while unrelated builds/benchmarks run can be noisy.

## Workload

The generator uses reviewed constants, fixed timestamps and sequential IDs. One user turn has five persisted messages: user, assistant with thinking and two tool calls, `read` result, `bash` result and final assistant Markdown. That is 500 / 5,000 / 50,000 messages and twice as many calls as user turns.

Regular results contain 1,024 and 2,048 UTF-16 characters. Every 100 turns adds a 65,536-character log; the final bash result contains 1,048,576 characters. Strings contain Chinese and emoji and remain well formed. JSONL byte counts and SHA-256 fingerprints are reported; character counts are not byte counts.

The large bash result deliberately uses the ordinary historical `toolResult` shape. It exercises opening older sessions whose logs can be larger than the current managed-bash tail. It does not imply that the current managed-bash tool returns an uncapped 1 MiB tail. There are no invented tool algorithms, empty-history shortcuts, shell launches or copied production folding implementations.

## Timing boundaries

| Metric | Real path and measured boundary |
| --- | --- |
| `node.sessionOpenMs` | SDK `SessionManager.open()` loads/parses the JSONL file and constructs the manager |
| `node.selectedBranchMs` | SDK `getBranch()` walks the selected ancestry |
| `node.displayProjectionMs` | SDK `sessionEntryToContextMessages` projects that branch, the entry conversion used by the app transcript |
| `node.modelContextMs` | SDK `buildSessionContext()` folds model history |
| `node.sidebarTailReadMs` | App `selectedBranchHasMessages()` reads the session tail |
| `node.storeSnapshotMs` | Real `PiStore.applySnapshot()` reconciles an idle restored session |
| `node.turnGroupingMs`, `node.changeScopesMs` | Real `buildTurns()` and `collectChangeScopes()` fold all restored messages |
| `node.storeLiveTurnMs` | One synthetic live turn with streaming overlays, two tool lifecycles and five committed messages, dispatched against the restored history |
| `node.storeLateRoundMs` | A late assistant round is chronologically inserted into the existing history |
| `node.trajectoryHistoryFirstPageMs` | First `TrajectoryClient.page()` starts the production worker, indexes the full JSONL into an empty SQLite database and queries the latest page |
| `node.trajectoryLatestPageMs`, `node.trajectoryOlderPageMs` | Warm worker queries, including selected-branch filtering and pagination |
| `node.trajectoryDetailMs` | Worker authorizes and reads one historical tool-result document root |
| `node.trajectoryLargeFragmentMs`, `node.trajectoryLargeNextFragmentMs` | Worker validates a root-to-value trail and reads two bounded slices of the 1 MiB value |
| `renderer.firstScreenMs` | In real Chromium, from `PiStore.applySnapshot()` through synchronous production `ChatView`/`TrajectoryPane` mount and two animation frames |
| `renderer.trajectoryOlderInteractionMs` | Playwright clicks the real Older button, waits for a different page and two animation frames |
| `renderer.expandLargeToolMs` | Playwright opens the newest turn's real execution disclosure and large bash result, then waits for two animation frames |
| `renderer.liveDeltaFrameMs` | Real store streaming update, React render and two animation frames against the mounted long transcript |

Node modules and the renderer fixture are bundled from the checkout before measurement. The renderer uses a **production Vite/React build**, real app components and CSS, built preload and real trajectory IPC/worker. Only external session/task services are fixtures. Module download/evaluation, process launch, input generation, snapshot transfer and fixture builds are outside the listed timing boundaries. Consequently `firstScreenMs` is initial transcript rendering cost, not full app cold launch or click-to-session-open latency. The Node restoration measurements cover separate parts of that larger path.

The trajectory side starts from the database already indexed by the same sample's Node phase; its UI page interaction is warm. Playwright-controlled interaction times include driver/control overhead. Two animation frames indicate rendering opportunities, not hardware presentation. Motion is reduced, viewport is 1,220 × 800, and the fixture uses the square/light appearance.

## Bounds and memory interpretation

Deterministic checks guard real counts independently of machine timing:

- Restored/committed messages, grouped turns, scope identities and trajectory totals match the generated workload.
- A trajectory page contains at most 80 records; inspected object fields at most 40; a value fragment at most 16,384 Unicode codepoints. Adjacent pages have no overlapping IDs, and the large value requires continuation.
- The trajectory renderer has at most 80 rows, 40 field buttons and 2,500 elements.
- Initial transcript DOM is bounded by `200 × turns + 1,000` elements. Exactly one assistant display row appears per generated turn.
- The expanded historical result is bounded by `4 × outputLines + 1,000` elements in its owning turn. This is a per-input-line growth guard, **not a fixed-size output viewport/DOM guarantee**.
- Renderer page errors must be zero.

The transcript uses `content-visibility: auto` for offscreen rendering; its total DOM still grows with turn count. The output scrollport caps visible height, while current `AgentCode` retains all output-line elements. The report keeps those costs explicit instead of treating visibility caps as virtualization.

Node reports starting and post-worker-exit memory, requested-GC status, RSS delta and process-lifetime maximum RSS. RSS includes native allocations and worker/process overhead; maximum RSS also includes untimed fixture setup. None is a retained JavaScript heap measurement. Renderer CDP reports JavaScript heap and DOM/listener counts after interactions without forced GC; detached nodes may remain until GC, and GPU/native/OS resident memory is excluded. `performance.memory` is included when available but is not required. Do not compare these numbers to each other as if they had the same scope.

The synthetic branch is linear and uncompacted. This benchmark does not cover API/provider latency, PiManager activation/extension loading, file previews, background process lifetime, terminal throughput, real disk-cold startup, forks/rewind/compaction semantics or full Workspace chrome. Those still use their existing functional checks. An observed performance issue should be investigated separately; this benchmark does not make broad virtualization changes to meet a new gate.

## Initial validation and observed limit

On 2026-09-27, the default 100-turn / three-sample run passed on Apple M5, 24 GiB RAM, Darwin arm64, Node 24.14.1 and Electron 44.3.0. A separate **single-sample** full run completed 100 and 1,000 turns; its 10,000-turn Electron phase exceeded the 180-second deadline. A follow-up with a 30-second deadline identified `mount-transcript` as the stalled stage and retained the completed 10,000-turn Node measurements.

| Turns | SDK open | Worker first history/page | Initial ChatView render | Initial chat elements |
| --- | --- | --- | --- | --- |
| 100 | 4.6 ms | 78 ms | 146 ms | 8,709 |
| 1,000 | 23 ms | 619 ms | 2,101 ms | 87,009 |
| 10,000 | 170 ms | 8,746 ms | Deadline exceeded | Not measured |

These are observations from that follow-up single sample, not calibrated budgets or comparable median baselines. **The full renderer run did not pass.** No successful 10,000-turn first-screen, DOM or renderer-memory measurement is claimed. The benchmark exposes that existing limit while the quick mode remains usable for ordinary regression checks.
