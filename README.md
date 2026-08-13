# vision-bridge

Give text-only models (e.g. DeepSeek) image understanding — transparently, without switching models.

Images are intercepted **before** they reach the text-only model, sent to a vision model, and replaced in place with a text description. The active chat model never changes — it just receives prose.

**Host-agnostic core + thin adapters.** The bridge logic (vision calls, caching, dedup, concurrency) lives in `src/core.ts` with zero host dependencies; each host gets a small adapter that maps its message format onto the core.

```
you attach / screenshot an image
        │
        ▼
host adapter
        │  OpenCode / pi (fast path):
        │    vision model describes the image; the image is
        │    replaced in place with text
        │  Grok (no intercept):
        │    host keeps the pixels + an <image_files> path;
        │    the model must call the CLI to get a description
        ▼
chat model (e.g. DeepSeek) answers from prose
        │  if the description misses a detail it needs
        │  ("what's the error code on line 3?")
        ▼
re-query (OpenCode `vision` / pi `view_image` / Grok CLI) →
vision model re-examines the original with that question
```

- **Fast path** (OpenCode / pi): one-shot summary, zero extra round-trips
- **Re-query path**: the original image stays available; the model asks targeted questions on demand
- **Grok**: CLI + skill only — see [Grok](#grok)

## Layout

```
src/
├── core.ts              # host-agnostic core: config, vision calls, LRU cache,
│                        #   in-flight dedup, concurrency (zero host imports)
├── hooks/
│   ├── opencode.ts      # OpenCode adapter (messages.transform + vision tool)
│   ├── pi.ts            # pi adapter (input event + view_image tool)
│   └── grok.ts          # Grok adapter (CLI re-query; do not install as a hook)
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

### Grok

Grok Build's TUI has **no** `messages.transform`. A pasted image is saved under
the session `assets/` directory and referenced as an `<image_files>` path; the
pixel payload is still attached to the user turn and sent to the chat model.
A text-only model (DeepSeek) ignores or rejects those `image_url` parts.

Grok itself already implements an official describe pipeline
(`transcribe_user_images` in `xai-grok-shell`, model from
`[models] image_description`, default `grok-build`). It only runs when
`is_cursor_harness()` is true, which is hardcoded `false` in the current TUI
build — so that pipeline does not run here.

This adapter therefore does **not** intercept or replace images. It only
exposes a CLI the model can call, and **only for DeepSeek-family chat
models** (id contains `deepseek`). Other models (Grok, GPT, …) are a no-op.
`VISION_ENABLE_MODELS` replaces that default with an explicit allowlist.

**Do not** register `grok.ts` as a `UserPromptSubmit` / `PostToolUse` hook:
Grok discards hook stdout (`additionalContext` is not consumed) and the hook
would bill the vision API for a result nobody reads.

**Install the skill** (tells the model to describe before answering):

````bash
mkdir -p ~/.grok/skills/vision-bridge
cat > ~/.grok/skills/vision-bridge/SKILL.md <<'EOF'
---
name: vision-bridge
description: >
  DeepSeek-only image describe. Invoke ONLY when the active chat model id
  contains "deepseek" AND the user pasted an image, the prompt has
  <image_files> paths, or chrome-devtools returned a screenshot.
  Never use on grok, gpt, claude, or other multimodal models.
---

You cannot see images. If a description is missing, run this before answering:

    node --experimental-strip-types /ABS/PATH/TO/vision-bridge/src/hooks/grok.ts <absolute-path> [specific question]

Path comes from `<image_files>`, a user-supplied file path, or a
chrome-devtools screenshot path. Omit the question for a full description.
EOF
````

Replace `/ABS/PATH/TO/vision-bridge` with this repo. Restart Grok (or wait
for skill reload).

**Re-query CLI:**

```bash
node --experimental-strip-types src/hooks/grok.ts <abs-path>           # full description
node --experimental-strip-types src/hooks/grok.ts <abs-path> "What is the error on line 3?"
```

Uses the same `VISION_*` env / OpenCode `kimi-for-coding` key as the other
adapters. The CLI resolves the session model from `GROK_SESSION_ID` /
`summary.json`, then `~/.grok/config.toml` `[models].default`. Descriptions
are cached on disk under `$TMPDIR/grok-vision-bridge-cache/`.

Automatic in-place transcription (OpenCode/pi-style) requires a Grok source
change — run `transcribe_user_images` for non-vision chat models — not a
change in this repo.

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

Hosts that can rewrite messages (OpenCode, pi) are ~100 lines:

1. **collect** `ImageSource[]` (`{ dataUrl, context }`) from the host's message format
2. call `bridge.describeAll(sources, hintFor?)` — caching/dedup/concurrency handled
3. **write** the returned `[Image N]` text blocks back into the host's message format
4. (optional) register a re-query tool that calls `describeImage(dataUrl, question, cfg)`

Hosts that cannot rewrite the outbound request (Grok TUI today) cannot do a
fast path. Ship a CLI + a skill that tells the model to invoke it; do not
pretend a lifecycle hook can inject context unless the host actually reads
hook stdout.

## Test

```bash
npm install
npm test
```

Cases across core / OpenCode / pi / Grok gate: image replacement, tool
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
- Grok TUI: `UserPromptSubmit` payload is `{ prompt }`; hook stdout is parsed only for blocking `PreToolUse` `{ decision, reason }`. `is_cursor_harness()` is `false`, so official `transcribe_user_images` never runs. MCP / chrome-devtools screenshots are inlined as `image_url` the same way pasted images are.

## License

MIT
