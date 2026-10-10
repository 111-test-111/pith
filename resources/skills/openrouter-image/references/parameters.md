# Parameter combinations

Checked 2026-10-04 against OpenRouter's native image guide, public model catalog
and individual endpoint records. These are `image` tool arguments: OpenRouter
wire fields such as `input_references` and `provider` are mapped by Pith.

## Read capabilities at the correct boundary

1. `GET https://openrouter.ai/api/v1/images/models` discovers native image models.
   A model's `supported_parameters` is the **union** of its endpoints.
2. `GET https://openrouter.ai/api/v1/images/models/{author}/{slug}/endpoints`
   lists the definitive parameter descriptors, routing identity and pricing for
   each endpoint. Follow the model's `endpoints` URL. These public reads need no
   generation and must not turn into a paid capability probe or credential lookup.
3. `enum.values` lists accepted strings; `range.min/max` bounds counts/integers;
   a boolean descriptor marks support. An absent key supplies no support claim.
   Router-level `size` normalization is an exception explained below; encoding
   defaults also need the model's docs if no descriptor is published.
4. Intersect endpoint capabilities with the live tool schema. Pith's schema is
   an app-wide ceiling, not evidence that each model accepts every listed value.
   For necessary generation controls use `protocol: "native"` and verify the
   saved output. `require_parameters: true` blocks incompatible chat downgrades
   locally; native provider filtering by this field is not documented. If pinning an endpoint,
   use its `provider_tag` in top-level `only` (not a display name); a null tag
   means endpoint pinning is unavailable.

Use the available browser or read-only network tools for these GETs. Never use
the provider's credential files. A current endpoint record takes precedence
over this dated reference. The [discovery reference](https://openrouter.ai/docs/api/api-reference/images/list-image-models)
and [generation guide](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
describe these distinctions.

## Dimensions: choose one representation

| Control | Meaning and useful values | Combination rule |
| --- | --- | --- |
| `resolution` | A provider-specific tier. Pith accepts `512`, `768`, `1K`, `1.5K`, `2K`, `4K`; each model accepts a subset. Capital `K` matters. | Prefer together with a supported `aspect_ratio`. A tier is neither guaranteed width nor pixel count. |
| `aspect_ratio` | Width:height. Square `1:1`; landscape `4:3`, `3:2`, `16:9`; portrait `3:4`, `2:3`, `9:16`; social `4:5`, `5:4`; extended `1:2`, `2:1`, `21:9`, `9:21`, `1:4`, `4:1`, `1:8`, `8:1`. | Use only the selected endpoint's subset. `auto` is an explicit value supported by some endpoints; omitting the ratio does not require support for that value. |
| `size` | OpenRouter convenience normalization: a tier such as `2K`, or ASCII pixels such as `1024x1024`. A tier is equivalent to `resolution`; pixels are authoritative. | Use a tier **or** `resolution`, not both. A tier can combine with `aspect_ratio`. For pixels, omit both other fields to avoid disagreement. |

The router may derive/clamp provider dimensions, so an accepted request does not
guarantee exact pixels. Do not use `size` to bypass a missing tier or an
unsupported ratio. The endpoint descriptor may omit `size` because the router
normalizes it first; verify its resulting tier/ratio or provider pixel limits.
When exact output pixels are essential, choose a model with documented pixel
support and verify the file. Do not silently crop/resize a result to claim
native compliance. [OpenRouter size semantics](https://openrouter.ai/docs/api/api-reference/images/generate-an-image).

Examples of compatible combinations (only the control fragment is shown):

| Model / intent | Send | Avoid |
| --- | --- | --- |
| Gemini 3.1 Flash, wide 2K tier | `{"resolution":"2K","aspect_ratio":"16:9"}` | Redundant/conflicting `size`. |
| Same tier expressed as shorthand | `{"size":"2K","aspect_ratio":"16:9"}` | Adding `resolution`. |
| GPT Image 2.5, exact square request | `{"size":"1024x1024","quality":"high"}` | Claiming the GPT family has Gemini's resolution tiers. |
| GPT Image 1, landscape | `{"size":"1536x1024","quality":"medium"}` | `size:"2048x2048"`; this earlier model's supported sizes differ. |
| Klein, wide draft | `{"aspect_ratio":"16:9","output_format":"png"}` | `resolution:"4K"` or `quality:"high"`; its endpoint advertises neither knob. |
| Seedream 5.0 Lite, large portrait | `{"resolution":"4K","aspect_ratio":"3:4"}` | `resolution:"1K"`; Lite starts at 2K. |

For GPT Image 2.5 the upstream recommends `1024x1024`, `1536x1024` and
`1024x1536`. Additional pixel sizes depend on the exact model and route; do not
copy older model limits onto a new family. See the [OpenAI image guide](https://developers.openai.com/api/docs/guides/image-generation).

Gemini 3.1 Flash illustrates why tiers cannot be translated with one generic
formula:

| Ratio | `1K` pixels | `2K` pixels | `4K` pixels |
| --- | --- | --- | --- |
| `1:1` | 1024x1024 | 2048x2048 | 4096x4096 |
| `16:9` | 1376x768 | 2752x1536 | 5504x3072 |
| `9:16` | 768x1376 | 1536x2752 | 3072x5504 |
| `4:3` | 1200x896 | 2400x1792 | 4800x3584 |

These are published model dimensions, not a promise for every OpenRouter route.
Flash Lite only offers 1K through the researched native endpoints. Pro has its
own dimension table and endpoint-dependent tiers. [Google dimensions](https://ai.google.dev/gemini-api/docs/image-generation).

## Quality, encoding and alpha

| Control | Use | Pitfall |
| --- | --- | --- |
| `quality` | `auto`, `low`, `medium`, `high` are Pith's exposed values. Use a quality knob only where advertised. | GPT Image 2.5 also advertises `xhigh`/`max` upstream, but Pith's current schema cannot send them. Most Gemini/FLUX/Seedream endpoints have no quality knob. A model tier is a separate choice. |
| `output_format` | `png`, `jpeg`, `webp`, `svg` are the tool ceiling. PNG for lossless raster/alpha; JPEG for opaque photos; WebP where supported; SVG for vector models. | No raster-to-vector conversion occurs by choosing SVG. A format missing from endpoint descriptors needs explicit model documentation; otherwise omit it and inspect the actual return. |
| `background` | `auto`, `opaque`, `transparent`, on supporting endpoints. | Transparent needs actual alpha and PNG/WebP. `output_format:"png"` alone does not request a cutout. GPT Image 2's current OpenRouter endpoint only advertises auto/opaque; OpenAI's preview support is a separate boundary. |
| `output_compression` | Integer 0–100 for a supported JPEG/WebP encoding. Upstream GPT image APIs default to 100. | Omit for PNG/SVG. This encoding control does not replace rendering quality. |

For an alpha asset, use a model/route that supports both requirements:
`background:"transparent"`, `output_format:"png"` (or supported WebP), with
`protocol:"native"`, and ask for an alpha-transparent background in the
prompt. GPT Image 2.5 and GPT Image 1/Mini document this workflow; omit
`output_compression` for PNG. Encoding is documented separately from the
incomplete GPT endpoint descriptor maps. [Upstream output controls](https://developers.openai.com/api/docs/guides/image-generation).

A contradictory live descriptor needs judgment, not the union of its values:
Riverflow V2.5 Fast advertises transparency but JPEG-only output. JPEG cannot
carry alpha; choose a verified alpha-capable model instead. Likewise, preserve
transparency from an input only when the selected editing route supports it.

## Counts, references, seeds and routing

- `n` is an upper bound, 1–10 in Pith. The per-endpoint maximum can be one,
  four or six; a provider can return fewer. Start with one unless multiple
  outputs were requested. A multi-output request needs a directory destination.
  For a single-image model and a request for several variants, make separate
  sequential calls with distinct destinations rather than sending unsupported
  `n>1`. Compare the actual output count to the user's request before finishing.
- `input_images` is a list of local file paths. Effective maximum is
  `min(8, endpoint.input_references.max)`. Pith accepts validated PNG/JPEG/GIF/WebP,
  up to 32 MiB each and 64 MiB total; upstream limits may be smaller. Prefer
  ordinary PNG/JPEG/WebP references and a single frame for animated input.
  SVG is an output option, not an accepted edit source; rasterize it first
  through available local tooling if the task needs it.
- `seed` is a nonnegative integer in the app, not an all-model determinism
  switch. Use it only when advertised (e.g. FLUX.2, Seedream, Qwen). Equal seeds
  do not guarantee equal output across providers, versions or changed inputs;
  seed ranges can be narrower upstream. Keep an actual output as the reference
  for later edits rather than relying on a seed to reconstruct it.
- `only` restricts providers; `order` prefers them; `ignore` excludes them.
  `allow_fallbacks:false` prevents upstream fallback; it does not choose a
  different image model. Carry user restrictions into retries.
- Protocol boundaries matter for routing. OpenRouter's current
  `ImageGenerationProviderPreferences` schema advertises `only`, `order`,
  `ignore`, `allow_fallbacks`, `sort` and `options`; Pith exposes the first four.
  It does not advertise `require_parameters` or `data_collection`. Pith forwards
  those legacy fields, but native server enforcement is unverified. Do not use
  them as native capability or privacy guarantees. [Official OpenAPI](https://openrouter.ai/openapi.json).
- On the chat protocol, `data_collection:"deny"` restricts eligible providers;
  it is not a promise of every data-retention policy. If the user requires it,
  choose `protocol:"chat"` only when that route also meets the generation needs.
  If required dimensions/alpha/encoding demand native controls, explain the
  incompatibility and obtain a changed requirement before sending the request.
  [Chat provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).
- The app's **chat adapter** cannot express `n>1`, `resolution`, `aspect_ratio`,
  `size`, `quality`, `output_format`, `background`, `output_compression` or `seed`.
  It reports them in `ignoredParameters`; `require_parameters:true` rejects that
  downgrade before making the chat request. Routing restrictions remain applied.
  A supported request still requires output inspection.
- Do not invent tool arguments from upstream examples: Pith does not expose
  `provider.options`, `steps`, `guidance`, `negative_prompt`, `mask`,
  `input_fidelity`, `moderation`, font inputs, grounding, streaming or safety
  tuning. Explain a capability gap when it matters instead of bypassing the tool.

## Complete tool calls

Use these as shapes, adapting the prompt, paths and requirements to the task.

Fast opaque draft:

```json
{
  "action": "generate",
  "model": "black-forest-labs/flux.2-klein-4b",
  "prompt": "A small red sailboat on a calm lake, flat editorial illustration, warm evening light, generous empty sky.",
  "aspect_ratio": "16:9",
  "output_format": "png",
  "output_path": "images/sailboat.png"
}
```

4K tier with the researched eligible Gemini Pro route; verify the current
endpoint before pinning it:

```json
{
  "action": "generate",
  "model": "google/gemini-3-pro-image",
  "prompt": "A botanical wall print of three fern species, accurate leaf shapes, delicate watercolor texture, no lettering.",
  "resolution": "4K",
  "aspect_ratio": "3:4",
  "only": ["google-ai-studio/global"],
  "protocol": "native",
  "output_path": "images/ferns/"
}
```

Edit a real local reference into an alpha asset:

```json
{
  "action": "edit",
  "model": "openai/gpt-image-2.5-sunburst",
  "prompt": "Use image 1. Keep the entire toy robot, its shape and colors. Remove the background and all cast shadows, leaving an alpha-transparent background with clean edges.",
  "input_images": ["images/robot-source.png"],
  "size": "1024x1024",
  "quality": "high",
  "background": "transparent",
  "output_format": "png",
  "protocol": "native",
  "output_path": "images/robot-cutout.png"
}
```

Two SVG design alternatives, subject to the endpoint's output count:

```json
{
  "action": "generate",
  "model": "recraft/recraft-v4.1-vector",
  "prompt": "A new minimal logo for a sailing club: one red sail above a navy wave, flat shapes, no text or gradients.",
  "aspect_ratio": "1:1",
  "output_format": "svg",
  "n": 2,
  "protocol": "native",
  "output_path": "images/sailing-logo/"
}
```
