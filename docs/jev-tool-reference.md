# Using TypeSafe inside Pi

Use this reference for a judgment in the current Pi task. For writing a TypeSafe integration into a user's application, follow the official skill's live-docs and SDK workflow instead.

## Application modes

Settings → Jev selects **Off**, **Provide tool**, or **Jev workflow**. Off makes no model-driven Jev calls. Provide tool exposes `jev_decide` for enabled question types. Workflow routes and verifies the parent task through the app controller; the optional tool is hidden and children do not start recursive controllers. Follow the supplied workflow instructions, preserve the user's scope and reuse passed checks while their relevant source is unchanged.

A judgment grants no extra permissions, cannot approve a Plan or replace actual execution, and cannot convert a missing test into a pass. Do not bypass a disabled capability or paused workflow through SDK, shell, credentials or alternate transport. Jev receives text evidence; the primary model owns source/image inspection.

## Native tool contract

When `jev_decide` is in the active tools, use it directly. Its description lists the question types currently enabled in Settings → Jev. The app owns credentials, the model, cancellation and transport; a native call needs no SDK installation, API key, or HTTP client. Do not read credential files or implement a shell/HTTP workaround for a disabled native capability. If the tool is absent, follow the current app workflow and existing tools; explain Settings → Jev when enabling it is relevant to the user's request.

The native schema intentionally accepts a smaller surface than the general TypeSafe API:

- `state`: nonempty text, up to 32,000 characters. For several pieces of evidence, pass a JSON-encoded **string** with named fields, not a raw object. Include relevant excerpts, candidate IDs and source locations; omit secrets and unrelated history.
- `questions`: 1–32 independent named questions. IDs and Choice option keys start with an ASCII letter and contain only letters, digits or underscores (maximum 64 characters). Question IDs are not visible to Jev: put the full meaning and evidence references in `instructions`.
- `instructions` and criterion descriptions: nonempty strings, up to 2,000 characters each. Flatten the official SDK's structured instructions into a clear text instruction here.
- `choice`: `criteria` maps 2–32 candidate keys to descriptions. Include `none` when no candidate may fit. Candidate coverage matters: Jev cannot select an omitted candidate.
- `score`: `criteria` is an array of 2–10 concrete levels, ordered from low to high. The answer is a probability-weighted position from 0 to the number of levels minus one, not a percentage.
- `noul`: one yes/no question. Optional `criteria` must contain both `true` and `false` descriptions. The answer is P(yes), not intensity; no separate confidence value exists.
- Total serialized request: at most 64 KiB. Batch independent judgments about the same evidence. A dependent question needs a later request with fresh state.

## Example: checking one claim against actual evidence

Use this shape after retrieving the source. A positive judgment means the supplied evidence supports the specific claim; it does not replace running the test, reading the rest of the code or verifying that the excerpt is current.

```json
{
  "state": "{\"claim\":\"The test timed out, but there is no evidence of a failed assertion.\",\"evidence\":{\"source\":\"test-output\",\"text\":\"Runner stopped after 30 seconds. No assertion results were emitted.\"}}",
  "questions": {
    "supported": {
      "type": "noul",
      "instructions": "Does evidence.text support the complete claim in claim? Judge only this supplied test output.",
      "criteria": {
        "true": "The output reports a timeout and provides no failed assertion result.",
        "false": "The output contradicts the claim or does not establish the claimed timeout."
      }
    }
  }
}
```

## Example: ranking retrieved candidates

Retrieve a small candidate set first. Use one comparable Score per candidate when relevance is graded; use a Noul only for a well-defined yes/no property. Carry stable candidate IDs into the instructions and keep one shared rubric. Sort the answers in code, retaining original source references and the original search order for ties or service failure.

```json
{
  "state": "{\"query\":\"Where does Stop cancel a pending network judgment?\",\"candidates\":{\"a\":{\"path\":\"src/request-service.ts\",\"text\":\"cancel(owner) aborts each request controller matching the owner.\"},\"b\":{\"path\":\"src/settings-view.tsx\",\"text\":\"The settings page renders the connection test button.\"}}}",
  "questions": {
    "relevance_a": {
      "type": "score",
      "instructions": "How directly does candidates.a answer query? Evaluate only the supplied excerpt.",
      "criteria": ["Unrelated to cancellation", "Related context but not the cancellation implementation", "Contains the cancellation implementation"]
    },
    "relevance_b": {
      "type": "score",
      "instructions": "How directly does candidates.b answer query? Evaluate only the supplied excerpt.",
      "criteria": ["Unrelated to cancellation", "Related context but not the cancellation implementation", "Contains the cancellation implementation"]
    }
  }
}
```

## Consuming results

The native response contains `model`, `answers`, `elapsedMs`, `inputTokens` and `outputTokens`. Choice/Score answers include `probabilities` and `confidence`; Score also includes `legend`. These are judgments about the supplied evidence, not generated explanations. Never invent a Jev rationale or describe probabilities as test results. Preserve the source locations when reporting a judgment.

Use calibrated thresholds only when there is an evaluated application policy. For an ordinary coding task, ambiguous answers usually mean retrieving better evidence or reasoning with the main model. Do not repeat the same request merely to obtain a higher score. Preserve deterministic permission, Plan Mode and execution checks regardless of the answer.

`JEV_invalid_input` calls for correcting the request shape. `JEV_disabled`, `JEV_capability_disabled`, credential or authentication errors call for the relevant setting/key action by the user, not a transport workaround. For cancellation, timeout, rate limits, busy or unavailable service, return control to the existing workflow and report the limitation when it affects the result. Do not claim a successful judgment when the call failed.
