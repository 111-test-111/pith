# Vision for text-only models

Settings → Providers stores an optional vision model in the app settings. The picker lists models declaring image input; main validates the model and configured credentials before saving. Clearing the selection disables the bridge. Native image sessions retain the existing image path and never declare `vision_analyze`, including after model switches, extension changes and reloads.

`src/main/pi/vision.ts` owns a separate bridge per managed session. Its stream overlay runs before the text-only image guard and budget. For a text-only request, new user images and tool images from the current turn are analyzed by the selected vision model. The request is an ordinary authenticated `ModelRuntime.completeSimple` call with no tools, a factual image-analysis instruction and the user's request. Main receives textual evidence in place of image blocks. A failed or empty analysis stops that primary request; it never falls through to a blind answer.

Image analysis does not create a subagent. The explicit, model-only `vision_analyze` tool asks follow-up questions or compares historical images. It accepts a self-contained prompt and optional stable references; omitting references selects the latest image-bearing user/tool message. References resolve only against persisted user and tool-result images on the selected branch. A bounded request-only reference list survives compaction without sending image bytes to the main model.

## Persistence and accounting

Original images stay in SDK messages and JSONL. Only provider request copies replace pixels. Image signature checks, decoded byte bounds and SDK decoding/resizing apply to the helper input; tool images continue through the existing validation before persistence. Limits are eight images per analysis, 12 MiB per image, 32 MiB per batch, a bounded prompt/output and a maximum two-minute deadline (shorter app response deadlines apply).

Successful analyses are private custom entries, keyed by selected model, image references/content hashes and analysis prompt. The selected branch supplies the cache; abandoned branches and unknown references cannot leak images or reuse another branch's evidence. Reopen and fork retain persisted observations. Reusing an observation issues no provider call and adds no usage.

Each returned provider receipt is appended once through SDK `appendUsage`, attributed to the actual vision provider/model. The tool result and cache do not carry another canonical usage object. Existing session totals, cross-session usage and Goal accounting include these native standalone entries. The bridge checks the shared Goal allowance before analysis and again before the primary request.

## Admission and lifecycle

New image drafts in text-only sessions are checked before ordinary prompt/queue admission and Goal creation. Missing model/configuration/auth returns a typed rejection; the renderer removes the optimistic echo and restores the composer's original text/images/files. Retry checks attachments before changing branch selection.

Plan treats the owned tool as a read-only model call. Held references recheck model availability and admission. Children can analyze images only if `vision_analyze` is already in their frozen tool ceiling; settings and model changes never widen that ceiling. Scheduled sessions use the same request bridge without an interactive session of their own.

Parent abort, Stop, queue recall with Stop, disposal and model/vision-setting changes cancel the helper's actual provider signal. Timeout also aborts the request. Progress/errors are typed metadata with independent revisions and no image bytes or transcript sequence. Existing turn status rows show localized visual-analysis progress; explicit tool results show localized errors.

## Verification

```sh
npm run typecheck && npm run build
npm test -- --no-prepare --suite vision,vision-ui,image-safety,context-budget,context-detail,usage-stats,plan-mode,goal-accounting,model-picker --strict-skips
```

The vision suite uses real SDK sessions and isolated profiles with an offline provider fixture. It verifies native bypass, configuration/admission, user/tool images, follow-up references, branch cache/reopen, standalone billing, provider failures, cancellation/timeouts, child ceilings and metadata races. It does not measure real-provider analysis quality.
