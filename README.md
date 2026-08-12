# vision-bridge

Give text-only models (e.g. DeepSeek) image understanding — transparently, without switching models.

Images are intercepted **before** they reach the text-only model, sent to a vision model, and replaced in place with a text description. The active chat model never changes — it just receives prose.

**Host-agnostic core + thin adapters.** The bridge logic (vision calls, caching, dedup, concurrency) lives in `src/core.ts` with zero host dependencies; each host gets a small adapter that maps its message format onto the core.

```
you attach / screenshot an image
        │
        ▼
host adapter (opencode / pi)
        │  ① fast path: vision model describes the image,
        │     the image is replaced in place with text
        │  ② (opencode) the original is saved to a local sandbox,
        │     the replacement text carries its path
        ▼
chat model (e.g. DeepSeek) receives plain text and answers
        │  if the description misses a detail it needs
        │  ("what's the error code on line 3?")
        ▼
chat model calls the re-query tool on its own →
vision model re-examines the original image with that specific question
```

- **Fast path**: one-shot summary covering "what is this image" scenarios, zero extra round-trips
- **Re-query path**: the original image is always available; the model asks targeted questions on demand, iteratively approaching lossless

## Layout

```
src/
├── core.ts              # host-agnostic core: config, vision calls, LRU cache,
│                        #   in-flight dedup, concurrency (zero host imports)
├── hooks/
│   ├── opencode.ts      # OpenCode adapter (messages.transform + vision tool)
│   └── pi.ts            # pi adapter (input event + view_image tool)
└── index.ts             # re-exports
dist/
├── opencode-plugin.js   # built single-file OpenCode plugin (npm run build)
└── pi-extension/        # built pi extension source
tests/                   # core + adapter tests (all API calls mocked)
scripts/build.mjs        # esbuild bundling
```

## Install

### OpenCode

```bash
npm run build
cp dist/opencode-plugin.js ~/.config/opencode/plugins/
```

Restart OpenCode. The bundled plugin is self-contained (core inlined).

### pi

```bash
# copy the built pi extension (or use src/ directly; pi loads TS natively)
mkdir -p ~/.pi/agent/extensions/vision-bridge
cp dist/pi-extension/index.ts ~/.pi/agent/extensions/vision-bridge/
cp package.json ~/.pi/agent/extensions/vision-bridge/   # then npm install there
```

Then `/reload` in pi. Beyond pasted attachments, the pi adapter also detects
image **file paths** in the input text (e.g. `pi-clipboard-*.png` files) and
describes them automatically.

### Config (env vars, all optional)

| Variable | Default | Notes |
|---|---|---|
| `VISION_BASE_URL` | `https://api.kimi.com/coding/v1` | OpenAI-compatible endpoint |
| `VISION_MODEL` | `k3-256k` | Vision model id |
| `VISION_API_KEY` | `kimi-for-coding` key from `~/.local/share/opencode/auth.json` | Explicit override |
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

## Writing a new adapter

Adapters are ~100 lines. They must:

1. **collect** `ImageSource[]` (`{ dataUrl, context }`) from the host's message format
2. call `bridge.describeAll(sources, hintFor?)` — caching/dedup/concurrency handled
3. **write** the returned `[Image N]` text blocks back into the host's message format
4. (optional) register a re-query tool that calls `describeImage(dataUrl, question, cfg)`

## Test

```bash
npm install
npm test
```

35 cases across core / OpenCode adapter / pi adapter: image replacement, tool
screenshot attachments, allowlist/blacklist/default gating, provider-agnostic
modelID matching, first-turn identification, unknown-model safety, sandboxing,
re-query tools, cache/dedup/retry, multi-image, `file://` images, input-path
detection. All API calls are mocked — the suite runs in under a second.

## Implementation notes

- Images in OpenCode messages are `FilePart`s (`type: "file"`, `mime: "image/*"`); there is no dedicated image part type
- `experimental.chat.messages.transform` receives a **deep copy** of the full history on every request — caching is a hard requirement
- Images returned by MCP tools live in the tool part's `state.attachments`; they go through the same transform pipeline
- The core caches by content hash, so identical images across providers/turns cost one vision call
- When the chat model handles images natively, leave it alone by configuring `VISION_SKIP_PROVIDERS` or a narrow `VISION_ENABLE_MODELS`

## License

MIT
