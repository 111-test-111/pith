---
name: openrouter-image
description: Generate or edit images with Pith's image tool through OpenRouter. Read before using image for model selection, compatible parameters, references and saved outputs.
---

# OpenRouter images in Pith

Read this skill before calling `image`. Read [model guidance](references/models.md)
for the selected family and [parameter combinations](references/parameters.md)
before choosing controls. Reuse guidance already present in context. This skill
uses Pith's first-party `image` tool and its configured OpenRouter account.

## Choose the model and controls

The user's explicitly named model takes priority over these recommendations.
Resolve a product name to its exact OpenRouter slug in the model reference; do
not silently substitute a different model or change a requested budget, format
or resolution. If the named model cannot meet a hard requirement, explain the
conflict and ask which requirement to change. Otherwise choose and proceed.

When the user leaves the model open, consider an eligible GPT Image 2.5 route
first for ordinary creative generation and reference edits: Flare for drafts and everyday work,
Sunburst for demanding edits, detailed final assets or text-heavy compositions.
This is a workflow preference, not a measured ranking. Keep cheaper draft,
native SVG, resolution, routing and budget requirements ahead of that preference.
Set `model` explicitly; omitting it still uses Pith's Klein default.
Catalog presence and a configured account do not establish region availability.
If a model is unavailable in the account or region, report the limitation. When
the user did not name a model, choose another eligible model that still meets the
request; otherwise obtain a changed model requirement before proceeding.

| Request | Starting choice | Reason / adjustment |
| --- | --- | --- |
| Everyday creative generation and reference edits | `openai/gpt-image-2.5-flare` | Preferred general starting point; speed tier of the GPT Image 2.5 pair. |
| Precise edits or detailed final output | `openai/gpt-image-2.5-sunburst` | Prefer for demanding fidelity, detail or composition requirements. |
| Simple illustration, fast draft, inexpensive iteration | `black-forest-labs/flux.2-klein-4b` | Pith's default; economical generation and edits with up to four references. |
| Fast 1K edits or reference composition | `google/gemini-3.1-flash-lite-image` | Efficiency tier; higher resolutions need another model. |
| Balanced quality, editing and larger output | `google/gemini-3.1-flash-image` | Broad ratios and resolution tiers, including small drafts. |
| Dense labels, infographic or complex composition | `openai/gpt-image-2.5-sunburst` | Start here when no model is named; Gemini Pro and Qwen Image 3 Pro are alternatives. Inspect every label. |
| Photorealistic texture, lighting and consistent references | `black-forest-labs/flux.2-pro` | Production-oriented balance; consider `black-forest-labs/flux.2-max` for greater quality investment. |
| Affordable high-resolution series | `bytedance-seed/seedream-5-0-lite` | 2K/4K and multi-image output; `seedream-4.5` is another batch/edit choice. |
| Alpha-transparent raster asset | GPT Image 2.5, or `openai/gpt-image-1` / `openai/gpt-image-1-mini` | Use a verified alpha-capable endpoint and encoding. The current OpenRouter GPT Image 2 endpoint does not advertise transparency. |
| Scalable vector illustration or new logo | `recraft/recraft-v4.1-vector` | Actual SVG output. Raster artwork described as “vector style” remains raster. |

These are task-based recommendations inferred from the linked model descriptions,
not a universal quality ranking or a promise of latency. [Model guidance](references/models.md)
has sources, tradeoffs and endpoint-specific limits. Keep existing project icons
and logos in their established vector/code system unless the user wants new artwork.

For a routine request, use one image and only controls the chosen endpoint
supports. Set the requested composition's ratio; pick a modest draft tier when
available, and increase detail/resolution for a final asset when requested.
Larger dimensions, quality settings, reference inputs and additional outputs can
change cost and latency independently. “Pro”, “Lite”, and “Flash” do not imply
the same controls across vendors. Set `model` explicitly when selecting above.

## Generate and edit

- Use `action: "generate"` for text-only generation. Use `action: "edit"` with
  `input_images` for an edit, style reference, identity reference or composition
  combining existing images. The tool's edit action is reference-conditioned
  generation; it does not expose a mask or guarantee pixel-exact preservation.
- Inspect available input images before editing. Use their actual local paths,
  including paths supplied with attachments. URLs, base64 and invented attachment
  paths are not accepted by `input_images`. If an input is unavailable, obtain
  the missing file through the available attachment/download flow first.
- The tool accepts at most eight inputs; a model may accept fewer. Match the
  order to explicit roles in the prompt: “image 1 is the scene; image 2 supplies
  the product; keep image 1's camera and lighting.” Each call is self-contained:
  include the last saved result again for the next edit and keep the original
  reference when identity/style must persist.
- State what changes and what must remain: subject identity, framing, layout,
  colors, lighting and exact text. Quote short required lettering verbatim.
  For factual charts/diagrams, supply verified values and relationships rather
  than expecting image generation to discover or calculate them. Small text,
  counts, anatomy and precise geometry need visual inspection after generation.
- Describe an alpha-transparent background explicitly as well as setting the
  supported controls. A painted checkerboard is not alpha transparency. Preserve
  an existing transparent input when the request calls for it.
- Keep `protocol` omitted/`auto` normally. Pith tries the other protocol only on
  a recognized mismatch. With a hard size/alpha/format requirement, use compatible
  controls and `protocol: "native"` to prevent a chat downgrade, then verify the
  saved output. `require_parameters: true` also blocks an unsupported chat
  downgrade locally; it is not a verified native provider capability filter.
  The app's chat adapter cannot forward these generation controls, even where
  OpenRouter's own chat API offers an `image_config` option.
- Native image routing does not currently document `data_collection`. Do not
  rely on `data_collection: "deny"` to enforce a native image privacy requirement.
  Use a verified eligible chat route if its controls meet the request, or explain
  the conflict and obtain a changed requirement before generating.

## Files, verification and failures

`output_path` is a local destination, independent of provider dimensions and
encoding. With no destination, the tool saves under `images/` in the session's
working directory. Prefer short, content-related filenames such as
`sailboat.png` or `fern-poster.png`. Do not put timestamps, dates, model names,
provider names or generation settings into image filenames. Set an explicit
`output_path` to choose the name deliberately. The tool's automatic fallback is
a short name derived from the prompt, with numeric suffixes for collisions or
batch variants. For images with different subjects, prefer explicit short names
in separate single-image calls when practical.
Use a directory for multiple requested images. Use a new
filename for an edit unless the user intends to replace the original; replacing
an existing explicit file needs `overwrite: true`.

Wait for the call to finish; a slow render is not evidence of failure. Do not
start a duplicate paid request while one is pending. Read `isError`,
`details.error`, `details.files`, `ignoredParameters`, `renamed` and `usage`.
Only `files` are committed outputs; a failed batch can still have saved some
images. Use the returned absolute paths, actual MIME type and dimensions. A
requested extension can be corrected to match the returned encoding.

Inspect the resulting image against the request before declaring success. For
exact dimensions or transparency, check decoded dimensions/alpha with an
available local image reader; appearance and the requested controls alone do
not prove them. You MUST call `present` for **every successfully saved image**,
including successful edits and committed images from a partially failed batch.
Pass each returned absolute file path; `present` accepts at most eight files per
call, so split larger batches across calls. An image tool preview, a Markdown
embed or a final-response path alone does not satisfy this requirement. Report
partial success and unapplied requirements plainly. Prefer choosing a short
`output_path` before generation: presenting the returned original path also
retains Pith's generated-image display and exact replay controls.

For an unsupported parameter or conflicting size, correct the concrete mismatch
before retrying. For a transient failure, make at most one reasoned retry when
the task still needs it; inspect saved files first to avoid duplicates. Stop on
cancellation, authentication/billing failure, content-policy denial or session/file
admission denial. Do not bypass Plan/file restrictions, read credentials, or call an ad hoc provider
API to work around the tool. A failed local save after provider completion can
still retain billing; do not promise that any failed call was free.

Capability research was checked **2026-10-04**. New models, provider routing and
account/region availability can change. For an unfamiliar model, an endpoint
pin, unusual controls or a hard guarantee, consult the current public endpoint
records described in [parameter combinations](references/parameters.md). If
they are unavailable, use the documented conservative subset and disclose the
remaining uncertainty instead of inventing support.
