# Jev integration roadmap

The opt-in Router → executor → Verifier pipeline is implemented as WIP v1. [The integration contract](jev-integration.md#mandatory-workflow--wip-v1) describes the shipped modes, continuous execution, evidence boundary and failure behavior. The next steps below are not implemented features.

## 1. Measure quality, tokens and cache reuse

Run matched repository tasks in Off, Provide tool and Workflow modes with the same primary model, reasoning settings and task starting state. Separate cold-cache and warm-cache runs. Measure successful completion, incorrect stop decisions, unnecessary corrections, elapsed time, parent and child input/output/cache usage, and Jev calls/tokens. Compare cost at equal task quality; a higher cache-hit ratio alone is not evidence of lower cost. Keep provider-normalized usage categories separate and account for their current pricing rather than guessing a single token price.

The WIP already displays per-parent counters and retains branch-owned audit metadata. Add exported paired evaluation reports, child/compaction totals and decision/error latency before claiming production savings.

## 2. Improve verifier evidence

The WIP now retains normalized command outcomes, real patches/current source, child writes and file-version associations; concrete targets and repeated-target detection replace generic verification requests. Extend this with structured test assertions and atomic source-linked claims, plus coverage for shell-written paths not yet known to the ledger. Preserve unknown, truncated and omitted evidence explicitly. A semantic judgment cannot certify an unrun test. Evaluate false acceptance and unnecessary repair rates on representative coding tasks, including stale successes and contradictory answers. Do not choose a universal confidence threshold without calibration.

Use atomic claim/source support questions, informed by the official [citation-check pattern](https://docs.typesafe.ai/cookbooks/citation_check). Retrieval and tests remain deterministic app/tool work.

## 3. Route concrete subagent profiles

The WIP chooses a fixed workflow; the main model selects actual tools and agent profiles. A later router can choose from the live profile catalog. Bind the response to that catalog revision and validate the selected ID, model availability, frozen parent ceiling, Plan restrictions and concurrency limits immediately before dispatch. A stale or unavailable candidate requires a new decision or visible pause, never permission expansion. Keep one controller at the parent level.

## 4. Reduce repeated judgment work

Rerank a bounded shortlist of already retrieved excerpts when relevance is the remaining uncertain step; keep original source IDs, deterministic sorting and explicit no-match handling. This follows the official [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe); its reported gains and thresholds are not assumed to transfer to coding tasks.

Consider a bounded cache only for exactly matching evidence, question rubric and Jev model/version. Changed files, different claims or tool results must invalidate reuse. A transport failure is not a cached judgment. Keep routing and completion verification mandatory while workflow mode is selected.

## 5. Improve recovery and decision quality

Keep execution free of arbitrary round/request/time caps. Evaluate recoverable service-error retries and clearer evidence-driven blocker reporting. Preserve Stop, mode changes, queue ownership, approval and interrupted-run recovery. Add decision-quality diagnostics without transmitting entire conversations or credentials. The skill explains when and how judgments apply; the main-process controller remains the execution authority.
