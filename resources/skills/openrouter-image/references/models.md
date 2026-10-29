# Model guidance and native endpoint matrix

Research checked **2026-10-04**. Recommendations below are inferences from the
primary model descriptions and capabilities. Small paid smoke tests do not
establish a comparative quality ranking.
OpenRouter popularity measures usage, not quality. Prices and latency depend on
endpoint, dimensions, references and quality; look up current endpoint pricing
when the user supplies a budget. Do not promise fixed seconds or a fixed bill.

## Select for the task

- **General generation and editing:** Prefer [GPT Image 2.5 Flare](https://openrouter.ai/openai/gpt-image-2.5-flare)
  as the first general candidate when the user leaves the model open and an
  eligible route is available in their account/region. It is the
  speed-focused OpenAI choice for everyday creative work and iteration.
  [Nano Banana 2](https://openrouter.ai/google/gemini-3.1-flash-image) is an
  alternative for its wider ratio and resolution-tier options: `512` for small
  previews, 1K for everyday use, and 2K/4K for requested larger assets.
- **Detailed final / precise changes:** Prefer [GPT Image 2.5 Sunburst](https://openrouter.ai/openai/gpt-image-2.5-sunburst)
  for demanding editing accuracy, detail or complex composition. [Nano Banana Pro](https://openrouter.ai/google/gemini-3-pro-image)
  is another professional asset and complex-composition option. Keep the user's
  chosen model, budget and endpoint requirements ahead of these preferences.
- **Rapid draft / simple art:** [FLUX.2 Klein 4B](https://openrouter.ai/black-forest-labs/flux.2-klein-4b)
  is the economical FLUX option and Pith default. Use it for straightforward
  generation or reference edits before investing in a more elaborate render.
  [Nano Banana 2 Lite](https://openrouter.ai/google/gemini-3.1-flash-lite-image)
  targets fast 1K generation/edits and composition; it cannot satisfy a 2K/4K
  requirement. [Recraft V4.1 Flash](https://openrouter.ai/recraft/recraft-v4.1-flash)
  suits inexpensive design drafts but is text-to-image only.
- **Photorealism / reference consistency:** [FLUX.2 Pro](https://openrouter.ai/black-forest-labs/flux.2-pro)
  emphasizes prompt adherence, lighting, textures and consistent style/subjects.
  [FLUX.2 Max](https://openrouter.ai/black-forest-labs/flux.2-max) is the higher
  quality investment within that family. [FLUX.3 Image](https://openrouter.ai/black-forest-labs/flux-3-image)
  is a newer flagship with explicit 768–4K tiers; its largest tier costs much
  more than its draft tiers, so verify pricing before selecting it for volume.
- **Words within the image:** Start with Sunburst for a demanding composition.
  [Qwen Image 3 Pro](https://openrouter.ai/qwen/qwen-image-3-pro)
  emphasizes text and fine detail. [FLUX.2 Flex](https://openrouter.ai/black-forest-labs/flux.2-flex)
  is another typography/detail-oriented choice when already working in FLUX.
  Gemini Pro is another suitable candidate. Preserve exact
  spelling/language in the prompt and inspect the output; tiny labels and
  complex multilingual paragraphs are not guaranteed by a model description.
- **High-resolution batch / consistent edits:** [Seedream 5.0 Lite](https://openrouter.ai/bytedance-seed/seedream-5-0-lite)
  offers 2K/4K and up to four outputs. [Seedream 4.5](https://openrouter.ai/bytedance-seed/seedream-4.5)
  supports larger batches, reference composition and editing consistency.
  [5.0 Flash](https://openrouter.ai/bytedance-seed/seedream-5-0-flash) is the fast
  generation/edit tier; [5.0 Pro](https://openrouter.ai/bytedance-seed/seedream-5-0-pro)
  targets heavier quality work. Unlike Lite/4.5, their researched endpoints stop
  at 2K and one image. A newer or “Pro” model is not automatically a 4K model.
- **True transparent background:** Prefer a verified GPT Image 2.5 endpoint.
  [GPT Image 1](https://openrouter.ai/openai/gpt-image-1) and
  [GPT Image 1 Mini](https://openrouter.ai/openai/gpt-image-1-mini) are established
  alpha-capable alternatives, with Mini the economical earlier tier.
  [GPT Image 2](https://openrouter.ai/openai/gpt-image-2) is suitable for opaque
  artwork, but its current OpenRouter native endpoint does not advertise
  transparency. OpenAI documents transparent output in preview for this model;
  that does not establish OpenRouter endpoint support. Recheck the route before
  choosing it for a cutout. [OpenAI background reference](https://developers.openai.com/api/reference/cli/resources/images/methods/generate).
- **New vector artwork:** [Recraft V4.1 Vector](https://openrouter.ai/recraft/recraft-v4.1-vector)
  and [Pro Vector](https://openrouter.ai/recraft/recraft-v4.1-pro-vector) return
  SVG for scalable graphics; Pro is the higher fidelity tier. Recraft raster
  models return raster, and Flash does not accept edit/reference images.
  Recraft “Styles” variants require at least one reference and generate in its
  style; they do not mean “edit this exact image”.

Prefer stable slugs above to `-preview` aliases unless the user selects a
preview. Product aliases: Nano Banana = `google/gemini-2.5-flash-image`, Nano
Banana 2 = `google/gemini-3.1-flash-image`, Nano Banana Pro =
`google/gemini-3-pro-image`, Nano Banana 2 Lite =
`google/gemini-3.1-flash-lite-image`. A vision-capable chat model is not
necessarily an image generator. The `openai/gpt-5-image*` and
`openai/gpt-5.4-image-2` wrappers add an LLM layer; prefer direct image slugs
for image-only work unless the user specifies the wrapper. See [OpenRouter's
Image API announcement](https://openrouter.ai/blog/announcements/image-api/).

## Ratio sets used in the table

These are the supported subset **expressible by Pith's current tool schema**.
Omit optional controls not listed for the selected family.

- **A:** `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `21:9`, `auto`.
- **B:** `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `4:5`, `5:4`, `16:9`, `9:16`, `21:9`.
- **C:** B plus `1:4`, `4:1`, `1:8`, `8:1`. No explicit `auto`.
- **D:** B plus `1:2`, `2:1`, `9:21`, `auto`.
- **E:** `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `auto`.
- **F:** `1:1`, `1:2`, `1:4`, `2:1`, `2:3`, `3:2`, `3:4`, `4:1`, `4:3`,
  `4:5`, `5:4`, `9:16`, `16:9`. No explicit `auto` or `21:9`.
- **G:** `1:1`, `3:2`, `2:3`, `auto`.

## Researched endpoint support

`—` means no advertised knob, not a default tier. Reference counts below are
Pith's effective ceiling (at most eight), not the upstream marketing maximum.
Use the [parameter reference](parameters.md) for `size` normalization and
output encodings whose descriptor maps are incomplete.

| Model slug | `resolution` tiers | Ratios | Max `n` / inputs | Other advertised tool controls |
| --- | --- | --- | --- | --- |
| `black-forest-labs/flux.2-klein-4b` | — | A | 1 / 4 | PNG/JPEG; seed |
| `black-forest-labs/flux.2-pro`, `black-forest-labs/flux.2-max`, `black-forest-labs/flux.2-flex` | — | A | 1 / 8 | PNG/JPEG; seed |
| `black-forest-labs/flux-3-image` | `768`, `1K`, `1.5K`, `2K`, `4K` | D | 1 / 8 | No advertised quality/seed/encoding knob |
| `google/gemini-3.1-flash-lite-image` | `1K` | C | 1 / 8 | No quality/encoding/background/seed knob |
| `google/gemini-3.1-flash-image` | `512`, `1K`, `2K`, `4K` | C | 1 / 8 | No quality/encoding/background/seed knob |
| `google/gemini-3-pro-image` | `1K`, `2K`; route-dependent `4K` | B | 1 / 8 | No quality/encoding/background/seed knob |
| `google/gemini-2.5-flash-image` | — | B | 1 / 3 | No resolution/quality/encoding/background/seed knob |
| `openai/gpt-image-2.5-flare`, `openai/gpt-image-2.5-sunburst` | —; use size | A | 10 / 8 | Quality auto/low/medium/high in Pith; transparent/opaque/auto; compression |
| `openai/gpt-image-2` | —; use size | A | 10 / 8 | Quality auto/low/medium/high; opaque/auto; compression |
| `openai/gpt-image-1`, `openai/gpt-image-1-mini` | —; use size | G | 10 / 8 | Quality auto/low/medium/high; transparent/opaque/auto; compression |
| `bytedance-seed/seedream-4.5` | `1K`, `2K`, `4K` | D | 10 / 8 | Seed |
| `bytedance-seed/seedream-5-0-lite` | `2K`, `4K` | D | 4 / 8 | Seed |
| `bytedance-seed/seedream-5-0-flash`, `bytedance-seed/seedream-5-0-pro` | `1K`, `2K` | D | 1 / 8 | Seed |
| `qwen/qwen-image-3`, `qwen/qwen-image-3-pro` | `1K`, `2K` | F | 6 / 4 | Seed |
| `recraft/recraft-v4.1`, `recraft/recraft-v4.1-pro` | — | E | 6 / 1 | Encoding defaults; omit raster encoding controls |
| `recraft/recraft-v4.1-flash` | — | E | 6 / 0 | Generation only; no edit/reference input |
| `recraft/recraft-v4.1-vector`, `recraft/recraft-v4.1-pro-vector` | — | E | 6 / 1 | SVG only |

Endpoint sources are the public records at
`https://openrouter.ai/api/v1/images/models/{full-model-slug}/endpoints`, checked
for the families above, and the [native model catalog](https://openrouter.ai/api/v1/images/models).
For example: [Klein](https://openrouter.ai/api/v1/images/models/black-forest-labs/flux.2-klein-4b/endpoints),
[Gemini Pro](https://openrouter.ai/api/v1/images/models/google/gemini-3-pro-image/endpoints),
[Sunburst](https://openrouter.ai/api/v1/images/models/openai/gpt-image-2.5-sunburst/endpoints),
[Seedream Lite](https://openrouter.ai/api/v1/images/models/bytedance-seed/seedream-5-0-lite/endpoints),
[Qwen Pro](https://openrouter.ai/api/v1/images/models/qwen/qwen-image-3-pro/endpoints),
[Recraft Vector](https://openrouter.ai/api/v1/images/models/recraft/recraft-v4.1-vector/endpoints).

Specific traps from these endpoint reads:

- Gemini Pro's `google-ai-studio/global` endpoint offers 4K; the researched
  `google-vertex/global` endpoint offers only 1K/2K. For required 4K, verify the
  current records and use the eligible route's `provider_tag` with
  `only:["google-ai-studio/global"]` and `protocol:"native"`, then inspect the
  output. `require_parameters` is not a verified native capability filter.
- The router lists some Seedream ratios with decimal terms (`9:19.5`, etc.)
  and FLUX.3 `7:5`/`5:7`; Pith's current enum cannot send them. Do not substitute
  a nearby ratio without the user's agreement if it is a hard requirement.
- The FLUX.2 endpoints do not advertise `resolution`; FLUX.3 does. “Up to 4 MP”
  in FLUX.2 documentation means pixel area, not the `4K` tier or a 4096px side.
- GPT Image 2.5's endpoint quality list extends to `xhigh`/`max`, beyond the
  current Pith enum. Choose a supported exposed quality, or explain the gap
  when the user requires one of the unavailable levels.
- Riverflow V2.5 Fast advertises a JPEG-only encoding alongside transparency.
  Treat that combination as incompatible with an alpha deliverable. Pith sends
  references as data URLs; [Sourceful's model notes](https://openrouter.ai/sourceful/riverflow-v2.5-pro)
  also describe a small request limit. The app's larger input cap does not
  override it, and Pith does not expose custom font inputs.
