# AI providers

Every AI-assisted feature goes through one interface, `AIProvider` (`src/ai/provider.ts`). No vendor is hard-coded. The provider is chosen in **Preferences ▸ AI**:

```
AIProvider
├── LocalAIProvider   built-in classical algorithms — offline, default
├── CloudAIProvider   your own HTTPS endpoint, documented JSON protocol below
└── CustomAIProvider  tasks contributed by sandboxed plugins
```

Features that use it:
- Select Subject, Select Sky and Remove Background;
- Content-Aware Fill, the Remove tool, and **Edit ▸ Generative Fill…** (creates a new layer; Generative Expand is in the provider API but has no UI yet — Coming Soon);
- Upscale and refine edges (Select and Mask).

If the selected provider can't do a task (see *Capabilities* in Preferences ▸ AI), the command explains why instead of failing silently.

## Local provider (offline)

| Task | Method |
|---|---|
| Select Subject / Remove Background | Lab-space k-means color models (background from the image border, foreground from the center-weighted interior), largest connected component + hole filling, guided-filter edge refinement |
| Select Sky | Flood fill from the top edge through smooth (low local variance) pixels that are blue-dominant or bright and neutral |
| Content-Aware Fill / Remove | Multi-scale PatchMatch inpainting (`src/ai/inpaint.ts`) |
| Upscale | Bicubic resampling with mild detail enhancement |
| Refine edges | Guided filter |

These are classical algorithms. They work well on clear subjects and simple backgrounds but are not machine-learning segmentation. The local provider has **no generative model**: Generative Fill tells you to configure a Cloud endpoint or plugin model and points to Content-Aware Fill, which works offline.

## Cloud provider protocol

Nothing is sent anywhere until you enter an endpoint. The endpoint must use **HTTPS**. Images are sent only when you run an AI command with the Cloud provider selected.

```
POST {endpoint}/v1/{task}
Content-Type: application/json
```

Images and masks are base64-encoded 8-bit PNGs. Masks are grayscale-in-RGBA, where white means selected or to be filled.

| Task | Request body | Response |
|---|---|---|
| `select-subject` | `{ "image" }` | `{ "mask" }` |
| `select-sky` | `{ "image" }` | `{ "mask" }` |
| `remove-background` | `{ "image" }` | `{ "mask" }` |
| `inpaint` | `{ "image", "mask" }` | `{ "image" }` |
| `generative-fill` | `{ "image", "mask", "prompt" }` | `{ "image" }` |
| `upscale` | `{ "image", "params": { "factor" } }` | `{ "image" }` |
| `refine-edges` | `{ "image", "mask", "params": { "radius" } }` | `{ "mask" }` |

Any non-2xx status is shown to the user with the response body. Responses must have the same size as the request image; for `upscale`, it's the size times the factor.

Authentication is intentionally not built in: put a gateway you control in front of your model service, as the endpoint URL. Celenne never stores API keys.

## Plugin models (CustomAIProvider)

A plugin declares `"aiTasks": ["select-subject", …]` and calls `celenne.registerAITask(task, fn)` (see [PLUGINS.md](PLUGINS.md)). The task names are the same as above, plus `generative-expand` and `face-aware`. Plugin tasks run in the plugin sandbox, which has no network access, so models must be bundled with the plugin code.
