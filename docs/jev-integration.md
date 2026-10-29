# Native Jev integration

Settings selects Off (default), Provide tool or Jev workflow. Tool mode exposes `jev_decide` with Choice/Score/Noul grants; workflow mode runs parent routing and verification independently of those toggles. A primary provider and TypeSafe key are still required. SDK 0.6.0/model `jev-1.13.0` are pinned in the implementation; no Pi skill is required.

## Service and credentials

`src/main/pi/jev/` owns validation, credentials, service and workflow. Saved `<agentDir>/jev-auth.json` takes precedence over `TYPESAFE_API_KEY`; mode 0600/atomic replacement protects a local plaintext file, not an OS keychain. Key values never cross settings IPC or enter localStorage. Unreadable saved credentials fail visibly.

Requests contain only supplied state/questions: up to 32 questions, Choice 2–32 options, Score 2–10 levels, optional Noul criteria supplied as a complete pair, serialized input up to 64 KiB. Validate result IDs/types/options/probabilities before persistence. The service pins HTTPS endpoint, disables SDK retries/logging, uses a 10-second deadline and four app-wide concurrent calls. Stop/disposal/shutdown/settings changes cancel owned requests; asynchronous credential lookup is followed by a fresh admission check. Failures expose safe stable codes, not SDK bodies/credentials.

The connection test sends a fixed synthetic report using all three question types and consumes API quota. It does not read the workspace or history. Jev tool access follows current parent grants and child frozen ceilings; Plan permits only the captured app-owned judgment tool, with no execution authority.

## Workflow

Public context/stream/tool/finish hooks run routing and verification for the parent session. Children execute their dispatched tasks without recursive Jev orchestration; Plan bypasses the implementation workflow. This controls the model loop, not arbitrary trusted extension code.

Router selects respond/inspect/act as guidance, preserving existing permissions. An explicit-action guard prevents an advice-only route from certifying requested implementation. At final response, the verifier gets a bounded ledger derived from the complete current selected-branch turn: real patches/current file versions, child changes, normalized command outcomes, request/answer and prior review targets. Todo updates alone are not implementation evidence; stale success does not prove current bytes.

The verifier selects complete/blocked/uncertain or one concrete task-bound repair/verification target. Continuation preserves successful work and avoids inventing new acceptance requirements. Repeating the same target without changed evidence, including A/B/A loops, pauses for review. There is no fixed correction count, primary-request or total-duration cap; cancellation, request deadlines, blockers and no-progress detection bound distinct failure paths. Pending processes/children/questions prevent premature completion.

Status/counters live in branch-owned `pith_jev_workflow_v1`; judgment input/output is separate `pith_jev_judgment_v1` diagnostic data outside model context. History pages contain 30 summaries; details load on expansion and follow branch/compaction/Rewind. Events use an independent revision, never transcript eventSequence. Reopened interrupted workflows pause, never replay. Parent counters exclude child and summary calls.

## Evidence and caching boundaries

Workflow automatically sends bounded task/patch/file/tool text excerpts to TypeSafe, disclosed by the mode control. It excludes image bytes, reasoning and arbitrary detail objects. Common credential patterns are redacted best-effort; this is not a general secret detector. A text verifier cannot certify unseen pixel-level results from unsupported executor claims.

Hidden guidance/corrections append without creating user turns or Rewind points. Stages retain system/schema and prior message prefixes; disabling workflow changes the request view. Provider cache policy still determines reuse. Jev adds requests/latency/tokens; no general net saving or decision-quality guarantee follows from the integration.

## Optional skill and verification

The upstream typesafe-ai skill may be installed separately. Its Pi bridge uses [the native reference](jev-tool-reference.md); it supplies no credentials or additional permissions. `adapt-typesafe-skill.mjs` preserves unrelated edits and the original body; it performs no download/install. Explicit invocation remains `/skill:typesafe-ai`.

```sh
node scripts/check-jev.mjs
node scripts/check-jev-evidence.mjs
node scripts/check-jev-skill.mjs
node scripts/check-settings-tabs.mjs
```

Offline checks use temporary profiles and cover cancellation, routing, evidence versions, loops, queues, recovery and settings. Optional private key-file environment switches enable real synthetic API probes; their success does not prove a live primary-provider workflow or general savings. Also run Plan, lifecycle, tool catalog and subagent checks when shared wiring changes.
