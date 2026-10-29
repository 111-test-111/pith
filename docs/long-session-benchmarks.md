# Long-session benchmarks

`scripts/benchmark-long-session.mjs` measures deterministic offline conversations through real SDK, PiStore, SQLite worker and production Electron renderer. It never uses a real provider, key or user session.

## Run and compare

```sh
npm run typecheck && npm run build
node scripts/check-long-session-benchmark.mjs
node scripts/benchmark-long-session.mjs --output=/tmp/pith-baseline.json
node scripts/benchmark-long-session.mjs --baseline=/tmp/pith-baseline.json --output=/tmp/pith-current.json
node scripts/benchmark-long-session.mjs --full --samples=1 --output=/tmp/pith-full.json
```

Default: 100 turns, three samples. Full: 100/1000/10000 turns. `--sizes`, `--samples=1..10` and `--timeout-ms=1000..600000` select explicit scales; default deadline is 180 seconds per Node/Electron sample. Fresh processes/profiles/JSONL/databases are cleaned on success/failure. JSON goes to stdout/output file, progress to stderr. Partial reports retain completed measurements and name a timed-out stage; incomplete samples never pass.

Exit 0 means bounds/comparison passed, 1 timing regression, 2 invalid/incompatible input, 3 setup/measurement/deadline/bound failure. Compare serial runs on the same idle machine, workload, versions, viewport, appearance and sample count. Commit changes are expected. Median ratio over the configured threshold and absolute increase above the noise floor both trigger a regression (defaults 1.5 and 5 ms). With three samples p95 is simply the largest sample. Fresh processes do not imply disk-cold caches.

## Workload and measured boundaries

Each turn stores user, assistant with two calls, read result, bash result and final Markdown. Regular results are 1024/2048 UTF-16 units; every 100 turns includes 65536 units; final historical bash output has 1048576 units with Chinese/emoji. This stresses historical logs, not an uncapped current bash result. Byte counts and SHA-256 fingerprints identify exact inputs.

Node measures SDK open/branch/context projection, sidebar tail, store reconciliation/live/late events, turn/change grouping and trajectory cold-index/warm-page/fragment reads. Electron measures production ChatView/TrajectoryPane mount, page interaction, expanded historical output and live-delta frames. Fixture setup, bundling, launch and snapshot transfer are outside these timings. First screen is transcript rendering cost, not whole-app cold-launch latency. UI trajectory pages are warm from the same sample's Node index phase.

## Interpretation and limits

Deterministic guards check counts, no overlapping trajectory pages, at most 80 record rows/40 inspected fields/16384-codepoint fragments and zero renderer errors. Transcript DOM has a per-turn growth bound; `content-visibility:auto` reduces offscreen rendering but does not virtualize the full transcript. Expanded code output also retains line DOM. Large-scale renderer deadlines can expose that cost; do not report partial/full timeouts as successful first-screen measurements.

Node RSS/max RSS includes native/worker/setup costs; CDP renderer heap/DOM excludes GPU/OS memory and is not forced-GC retention. These numbers have different scopes. Reports preserve raw samples, machine/config identity and memory/DOM values; timing comparison is not a memory gate or universal SLA.

This linear uncompacted corpus excludes API latency, PiManager activation/extension loading, file/terminal throughput, full Workspace chrome, branch/compaction/queue correctness and truly cold disks. Use topic regression scripts for those concerns. Store generated reports outside source control unless deliberately establishing a reviewed same-machine baseline.
