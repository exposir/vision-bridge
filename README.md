# opencode-vision-bridge

Give text-only models (e.g. DeepSeek) image understanding in [OpenCode](https://opencode.ai) — transparently, without switching models.

## The problem

Sending an image to a text-only model in OpenCode fails with `this model does not support image input`. This plugin intercepts the image **before** it reaches the model, sends it to a vision model, and replaces it in place with a text description. The active chat model never changes — it just receives prose.

Unlike similar plugins, this one has a **two-tier architecture**:

```
you attach / screenshot an image
        │
        ▼
experimental.chat.messages.transform (this plugin)
        │  ① fast path: vision model describes the image,
        │     the FilePart is replaced in place with text
        │  ② the original image is saved to a local sandbox,
        │     the replacement text carries its path
        ▼
chat model (e.g. DeepSeek) receives plain text and answers
        │  if the description misses a detail it needs
        │  ("what's the error code on line 3?")
        ▼
chat model calls the vision tool on its own →
vision model re-examines the original image with that specific question
```

- **Fast path**: one-shot summary covering "what is this image" scenarios, zero extra round-trips
- **Re-query path**: the original image is always available; the model asks targeted questions on demand, iteratively approaching lossless

## Features

- **Fully transparent**: pasted images and screenshots (image attachments returned by MCP tools) are handled automatically — no manual action, no model switching
- **Chat model unchanged**: the vision model is only a background "translator"; your session model stays the same throughout
- **Config-driven scope**: by default every model gets image bridging. Restrict with a whitelist (`VISION_ENABLE_MODELS`) or exclude providers (`VISION_SKIP_PROVIDERS`)
- **Works from the first turn**: current model is identified via the `chat.params` hook, no assistant message needed
- **Content-hash cache + in-flight dedup**: the same image is described only once per session
- **Graceful degradation**: vision API failure never blocks the conversation (errors are not cached; next turn retries automatically)
- **Sandboxed**: the `vision` tool can only read images the plugin itself saved

## Install

Copy `vision-bridge.js` into OpenCode's global plugin directory and restart OpenCode:

```bash
cp vision-bridge.js ~/.config/opencode/plugins/
```

By default it uses `kimi-for-coding/k3-256k` as the vision model, reading the API key from OpenCode's `auth.json` — zero configuration. To use any other OpenAI-compatible endpoint, see the env vars below.

## Configuration (env vars, all optional)

| Variable | Default | Notes |
|---|---|---|
| `VISION_BASE_URL` | `https://api.kimi.com/coding/v1` | OpenAI-compatible endpoint |
| `VISION_MODEL` | `k3-256k` | Vision model id |
| `VISION_API_KEY` | `kimi-for-coding` key from `auth.json` | Explicit override |
| `VISION_QUESTION` | built-in English prompt | Prompt used for image description |
| `VISION_ENABLE_MODELS` | _(empty = all models)_ | Comma-separated allowlist. Entries with `/` match `provider/model` exactly; bare entries match modelID regardless of provider |
| `VISION_SKIP_PROVIDERS` | _(empty = none skipped)_ | Comma-separated provider blacklist, used only when the allowlist is empty |
| `VISION_TIMEOUT_MS` | `120000` | Per-request timeout (one retry on 5xx/timeout) |
| `VISION_MAX_TOKENS` | `2048` | Max tokens for a description |
| `VISION_MAX_CONCURRENCY` | `3` | Max parallel vision calls |
| `VISION_CACHE_SIZE` | `100` | Description cache entries (LRU) |
| `VISION_DEBUG` | off | Set to `1` for debug logs |

Example — only bridge images for DeepSeek V4 Flash, regardless of provider:

```bash
export VISION_ENABLE_MODELS="deepseek-v4-flash"
```

## The `vision` tool

After replacement, the text carries a marker like:

```
[Image 1]
<description>
(Original image: /tmp/opencode-vision-bridge/<hash>.png — if the description
above misses details you need, call the vision tool: ...)
```

The chat model can call `vision({ path, question })` to re-examine the original image with a targeted question. The tool validates that `path` stays inside the plugin's sandbox (at most 100 images, LRU-pruned).

## Test

```bash
npm install
npm test
```

17 cases covering: image replacement, screenshot attachment handling, allowlist/blacklist/default gating, provider-agnostic modelID matching, first-turn identification, unknown-model safety, sandboxing, vision-tool re-query, cache/dedup/retry, multi-image, and `file://` images. All API calls are mocked — the suite runs in under a second.

## Implementation notes

- Images in OpenCode messages are `FilePart`s (`type: "file"`, `mime: "image/*"`); there is no dedicated image part type
- `experimental.chat.messages.transform` receives a **deep copy** of the full history on every request — caching is a hard requirement
- Images returned by MCP tools live in the tool part's `state.attachments`; they go through the same transform pipeline
- When the chat model handles images natively, leave it alone by configuring `VISION_SKIP_PROVIDERS` or a narrow `VISION_ENABLE_MODELS`

## License

MIT
