# Testing

The test catalog in [`scripts/tests/manifest.mjs`](../scripts/tests/manifest.mjs) is the single source of truth for suite ownership, behavior, execution layer, platform restrictions, build requirements and deadlines. `npm run test:list` prints it. Every top-level `scripts/check-*.mjs` must be registered; missing, duplicate or stale registrations fail before execution.

## Commands

Use Node 24 and run `npm ci` with install scripts enabled. The application supports older Node versions, but the test tools also use native TypeScript imports and SQLite. Tests never install adapters or request model credentials automatically.

```sh
npm test                            # Typecheck, prepare the build, then standard suites
npm run test:core                    # Deterministic contracts and SDK/filesystem integration
npm run test:ui                      # Electron component and application behavior
npm run test:native                  # Host sandbox and installed debugger adapters
npm run test:performance             # Isolated timing and workload measurements
npm run test:list                    # Catalog without preparation or execution
npm test -- --suite session-replay   # Select a specific risk
npm test -- --suite plan-mode,rewind  # Select multiple suites
```

Standard tests exclude the performance and live groups. Performance measurements run alone and serially. The `long-session-benchmark` contract checks reporting math; the `long-session-performance` suite measures the actual workload. See [long-session benchmarks](long-session-benchmarks.md) for same-machine baseline comparisons.

The runner executes suites serially because Electron, PTYs, fixed CDP ports and performance measurements share host resources. Each suite has a wall-clock deadline. Failures continue to the next suite and keep a nonzero final exit code; there are no automatic retries that hide flakiness. Timeout and interruption clean up owned processes before temporary fixture cleanup. POSIX tracking includes detached descendants that outlive their parent; Windows uses `taskkill /T` while the suite root is alive. Windows orphan recovery after an already exited root is outside the supported product-fixture scope.

Preparation runs once per invocation. After explicitly running `npm run typecheck && npm run build`, use `--no-prepare` to reuse that build. Changing source invalidates that assumption. Direct `node scripts/check-*.mjs` execution remains available for debugging, but it bypasses unified reporting and environment isolation.

## Results and coverage

`.test-results/` contains a run report in JSON, JUnit XML and individual suite logs. `--report-dir <path>` chooses another destination. Reports record selected suites, platform, durations, reasons and outcomes; generated output stays outside source control. `npm run clean` removes default reports.

Outcomes distinguish full passes, partial passes with skipped scenarios, skipped suites, failures, timeouts and interruptions. An exit-zero script that prints `SKIP` is incomplete coverage. `--strict-skips` makes skipped or partial coverage fail, and is used by required CI lanes. Optional native adapters remain visible as incomplete when absent.

The catalog and reports describe behavioral coverage, not a line-coverage percentage. Existing SDK and Electron checks bundle TypeScript into temporary modules and exercise multiple processes; counting those generated lines would give misleading product coverage. A passing fixture proves its specified scenario. It does not prove arbitrary live websites, real provider output or other operating systems.

## Isolation and prerequisites

Non-live suites receive temporary home, Pi configuration, cache, data and temp directories. The runner strips provider credentials and optional environment variables that enable live Jev, external extensions or Claude execution. Individual fixtures continue to isolate their Electron profiles. Local loopback servers and synthetic providers are allowed; standard tests need no external account.

Electron requires a desktop display. On headless Linux, use `xvfb-run --auto-servernum npm run test:ui`; Xvfb and Electron's system libraries must already be installed. Media seeking uses `ffmpeg` to generate a short video. Missing tooling is recorded as skipped coverage; install it before using `--strict-skips`.

Native debugger suites use installed adapters and compiler tools. Only the host Pi `debug-adapters/` directory is exposed inside the isolated native configuration; credentials and sessions remain isolated. Tools must be discoverable on `PATH` or in that adapter directory; packages installed only in a personal editor directory or Python user home may require installation into the test tool environment. Sandbox checks exercise the host backend where available and the fail-closed contract otherwise, with missing kernel enforcement recorded as skipped coverage.

On macOS/Linux, install Python's adapter into a dedicated virtual environment so it remains available with an isolated home:

```sh
python3 -m venv ~/.pi/agent/debug-adapters/debugpy
~/.pi/agent/debug-adapters/debugpy/bin/python -m pip install debugpy
npm run test:native -- --strict-skips
```

Native suites use this existing virtual environment when present. The runner never creates it or installs packages automatically.

```sh
npm run test:live                    # Explicit real-provider subagent scenario
```

The live group borrows the configured Pi provider and can incur model charges. It is never selected by standard/all tests or CI. Optional live Jev, extension and Claude experiments remain direct script invocations with their documented environment variables; they are not prerequisites for a repository regression pass.

## CI

[`Tests`](../.github/workflows/tests.yml) runs on pushes and pull requests:

- Ubuntu and macOS: production build and deterministic contracts/integration with strict skip handling. macOS also requires kernel sandbox enforcement; Linux reports host capabilities and fail-closed behavior, including any skipped enforcement.
- macOS: serial Electron UI suites, with `ffmpeg` installed and strict skip handling.
- Windows: typecheck, production build and portable runner infrastructure assertions, with POSIX-only process fixtures explicitly skipped. This lane allows partial coverage and does not claim Windows product runtime coverage; existing PTY and native fixtures require POSIX tools.

Manual workflow dispatch can also run native adapters and isolated performance measurements. Native skips remain explicit. Hosted-runner performance results check workload bounds; use a reviewed, compatible same-machine baseline to gate timing regressions. CI uploads logs and reports even after failure. It uses no model secrets.

## Keep the suite useful

Add a test for an observable failure: lost data, incorrect state, escaped permissions, broken IPC, unusable input or a measured resource regression. Test the smallest layer that proves the behavior. Use SDK integration for ownership/admission/persistence and Electron when browser layout, focus, input, decoding or process boundaries affect the outcome.

Prefer deterministic fixture inputs, observable outputs and bounded waits. Assert invariants rather than exact implementation strings, private React trees, incidental CSS values or tiny wall-clock thresholds. Keep shared harnesses under `scripts/lib/` and runner support under `scripts/tests/`; helpers must not appear as independently passing suites.

When a broader suite proves the same risk, merge or remove the redundant check. Dedicated form-token, rail-tab pixel and queue-row pixel checks were removed because they duplicated presentation rules without testing an action. Runtime settings, pane lifecycle, queue/session behavior, focus, scrolling and input checks remain. Terminal appearance is a helper exercised by the real PTY suite. Safety, durability, cancellation and failure-injection tests remain independent where they protect distinct failure modes.

When changing a feature, select its suite and adjacent shared-boundary suites from the catalog. Run typecheck/build and affected suites before delivery, and report failures, skips and anything not executed. Run standard suites before release; run native suites on each supported target and review their adapter coverage. Add live or performance runs when the change actually depends on those behaviors.
