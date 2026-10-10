# Runtime system prompt

Pi owns prompt assembly. The app supplies short `promptSnippet` / `promptGuidelines` on its tools; SDK sections retain the base assistant prompt, active tools, Pi documentation, working directory, user append files, project context and available skills. Tool declarations/schemas are additional model input and are not counted by the system-prompt viewer.

`src/main/pi/prompt-format.ts` uses the public `before_agent_start.systemPromptOptions` hook to compact default resource presentation. Documentation keeps the README/docs/examples roots, topic scope, full-file reading and cross-reference rules. Skills use one JSON row per `[name, description, absolute SKILL.md path]`, preserving all metadata and matching conditions. JSON encoding keeps multiline descriptions and special characters reversible; XML delimiter characters are escaped so metadata cannot close SDK sections. Disabled skills remain absent, and automatic skill guidance still requires an active `read` or `bash` tool.

The formatter runs before the app's Plan instructions. Existing `docs` / `skills` section overrides remain authoritative; custom `SYSTEM.md` and forced full prompts bypass formatting. Discovery, Settings catalogs, skill bodies and explicit skill invocation are unchanged.

Always-present guidance covers decisions that affect ordinary work: authorization, background completion, verified task status, child isolation, result failures and reference safety. Avoid repeating parameter documentation or the same rule across tools. Structured pending results and policy denials also carry context-specific instructions.

Debug recipes and adapter caveats live in `src/main/debug/usage.ts`. `debug` with `request:{action:"help",topic:"wait"}` returns one action's schemas and guidelines; omitting `topic` lists every action. These details enter context only when requested. Runtime permission checks remain in the action registry, independently of prompt wording.

Tool declarations also use conservative compaction in `src/main/pi/codemode-guidance.ts`: direct tools keep complete JSON parameter schemas and original descriptions, while generated duplicate TypeScript contracts are removed from request descriptions. Codemode keeps no inline nested contracts (`inlineBudget:0`); its existing `searchTools` / `describeTool` helpers discover full callable input/output contracts when needed. Registry schemas, handlers, exposure and policy checks are unchanged. See [native MCP and codemode](native-mcp-codemode.md).

Browser and scheduling descriptions use concise wording without changing field types, required fields, bounds, enums or execution. Browser guidance retains untrusted-page boundaries, target uniqueness, current refs, snapshot windows, timeout semantics and upload limits. Codemode replaces only the SDK introduction matched from its registered definition; model API types, shared MCP types and namespace instructions remain verbatim, with a full-text fallback for unmatched layouts. Execution limits, result failures, image forwarding, awaited work and branch-local store semantics remain explicit.

User `SYSTEM.md` / `APPEND_SYSTEM.md`, project instructions, skill descriptions and third-party extensions remain user-owned inputs. This optimization does not truncate them or change their loading settings. Large external inputs can still make a configured prompt much larger than the app baseline.

The viewer retains the latest ordinary provider request's system text after settlement, including per-turn extension and Plan overrides that the SDK's idle getter discards. This single in-memory snapshot is branch-anchored, excludes auxiliary compaction/summary requests, and is cleared by resource reload and disposal. Before a request or after reload, the viewer falls back to the SDK base; compact formatting becomes visible after the next ordinary turn. Request recording and provider payloads do not change.

`system-prompt` exercises actual SDK provider requests with an isolated profile: default runtime below 6,500 characters, optional debug/Jev/subagent features below 8,500, preserved append content across reload and on-demand debug help. Separate resource fixtures verify exact metadata round-trips, real skill-file reads, disabled skills, reload, Plan, custom prompts, section overrides and settled viewer parity. Size bounds exclude external skills, extensions and project instructions; fixtures do not claim live-model instruction adherence. Run:

```sh
npm test -- --no-prepare --suite system-prompt,plan-mode,extension-startup,tool-catalog,context-budget,session-replay --strict-skips
```
