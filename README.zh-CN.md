# vision-bridge

让纯文本模型（如 DeepSeek）拥有图像理解能力——无需切换模型，完全透明。

图片在到达纯文本模型**之前**被拦截，发送给视觉模型生成文字描述，并原地替换为文本。对话模型始终不变——它收到的只是文字。

**宿主无关的核心 + 轻量适配器。** 桥接逻辑（视觉调用、缓存、去重、并发）全部在 `src/core.ts` 中，零宿主依赖；每个宿主只需一个薄适配器，把宿主的消息格式映射到核心上。

```
你粘贴 / 截图一张图片
        │
        ▼
宿主适配器
        │  OpenCode / pi（fast path）：
        │    视觉模型描述图片，图片被原地替换为文字
        │  Grok（无法拦截）：
        │    宿主保留像素 + `<image_files>` 路径；
        │    模型必须调用 CLI 才能拿到描述
        ▼
聊天模型（如 DeepSeek）根据文字作答
        │  如果描述缺少它需要的细节
        │  （"第 3 行的错误码是什么？"）
        ▼
re-query（OpenCode `vision` / pi `view_image` / Grok CLI）→
视觉模型带着那个具体问题重新审视原图
```

- **Fast path**（OpenCode / pi）：一次性摘要，零额外往返
- **Re-query path**：原图始终可用，模型按需提出针对性问题
- **Grok**：只有 CLI + skill —— 见 [Grok](#grok)

## 目录结构

```
src/
├── core.ts              # 宿主无关核心：配置、视觉调用、LRU 缓存、
│                        #   in-flight 去重、并发（零宿主 import）
├── hooks/
│   ├── opencode.ts      # OpenCode 适配器（messages.transform + vision 工具）
│   ├── pi.ts            # pi 适配器（input 事件 + view_image 工具）
│   └── grok.ts          # Grok 适配器（CLI 按需重看；不要装成 hook）
└── index.ts             # 汇总导出
dist/
├── opencode-plugin.js   # 构建产物：OpenCode 单文件插件（npm run build）
└── pi-extension/        # 构建产物：pi 扩展源码
tests/                   # 核心 + 适配器测试（全部 mock API）
scripts/build.mjs        # esbuild 打包
```

## 安装

### OpenCode

```bash
npm run build
cp dist/opencode-plugin.js ~/.config/opencode/plugins/
```

重启 OpenCode 即可。打包产物是自包含单文件（核心已内联）。

### pi

```bash
# 复制构建好的 pi 扩展（或直接用 src/，pi 原生加载 TS）
mkdir -p ~/.pi/agent/extensions/vision-bridge
cp dist/pi-extension/index.ts ~/.pi/agent/extensions/vision-bridge/
cp package.json ~/.pi/agent/extensions/vision-bridge/   # 然后在其中 npm install
```

之后在 pi 里执行 `/reload`。除粘贴的图片外，pi 适配器还会自动识别输入文本中的图片**文件路径**（如 `pi-clipboard-*.png`）并描述它们。模型门控与 OpenCode 一致（`VISION_ENABLE_MODELS` / `VISION_SKIP_PROVIDERS`）：当前模型通过 pi 的 `model_select` 事件跟踪。

### Grok

Grok Build TUI **没有** `messages.transform`。粘贴的图片会存到会话 `assets/` 目录，并在文本里标成 `<image_files>` 路径；像素仍会作为 `image_url` 发给聊天模型。纯文本模型（DeepSeek）会忽略或直接拒绝这些 part。

Grok 源码里其实已有官方转述管线（`xai-grok-shell` 的 `transcribe_user_images`，模型来自 `[models] image_description`，默认 `grok-build`）。但它只在 `is_cursor_harness()` 为 true 时运行，而当前 TUI 构建里这个函数写死为 `false`，所以这条管线不会走。

因此本适配器**不会**拦截或替换图片，只提供一个模型可以调用的 CLI，并且**只对 DeepSeek 系列聊天模型生效**（model id 含 `deepseek`）。Grok / GPT 等其他模型会直接跳过。`VISION_ENABLE_MODELS` 可覆盖这个默认白名单。

**不要**把 `grok.ts` 注册成 `UserPromptSubmit` / `PostToolUse` hook：Grok 会丢掉 hook 的 stdout（不消费 `additionalContext`），hook 只会白烧视觉 API。

**安装 skill**（让模型在回答前先转述）：

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

你看不见图片。如果还没有文字描述，或描述缺了你需要的细节，回答前先执行：

    node --experimental-strip-types /ABS/PATH/TO/vision-bridge/src/hooks/grok.ts <绝对路径> [具体问题]

路径来自 `<image_files>`、用户给出的文件路径，或 chrome-devtools 截图路径。省略问题则生成完整描述。
EOF
````

把 `/ABS/PATH/TO/vision-bridge` 换成本仓库路径。重启 Grok（或等 skill 热加载）。

**按需重看 CLI：**

```bash
node --experimental-strip-types src/hooks/grok.ts <绝对路径>           # 完整描述
node --experimental-strip-types src/hooks/grok.ts <绝对路径> "第 3 行的错误码是什么？"
```

环境变量 / OpenCode `kimi-for-coding` key 与其他适配器相同。CLI 按 `GROK_SESSION_ID` / `summary.json`，再回落到 `~/.grok/config.toml` 的 `[models].default` 判断当前模型。描述缓存在 `$TMPDIR/grok-vision-bridge-cache/`，key 由文件标识 + 问题共同决定。

若要 OpenCode/pi 那种「贴图自动转成文字」，需要改 Grok 源码（对非视觉聊天模型走 `transcribe_user_images`），不是改本仓库。

### 配置（环境变量，全部可选）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VISION_BASE_URL` | `https://api.kimi.com/coding/v1` | OpenAI 兼容端点 |
| `VISION_MODEL` | `k3-256k` | 视觉模型 id |
| `VISION_API_KEY` | `~/.local/share/opencode/auth.json` 中 `kimi-for-coding` 的 key | 显式覆盖 |
| `VISION_QUESTION` | 内置英文提示词 | 图片描述使用的提示词 |
| `VISION_ENABLE_MODELS` | _(空 = 所有模型)_ | 逗号分隔白名单（OpenCode / pi；Grok 中会替换默认的 DeepSeek-only 白名单）。含 `/` 的条目精确匹配 `provider/model`；裸条目按 modelID 匹配、不限 provider |
| `VISION_SKIP_PROVIDERS` | _(空 = 不跳过)_ | 逗号分隔 provider 黑名单（OpenCode / pi），仅在白名单为空时生效 |
| `VISION_TIMEOUT_MS` | `120000` | 单次请求超时（5xx/超时重试一次） |
| `VISION_MAX_TOKENS` | `2048` | 描述的最大 token 数 |
| `VISION_MAX_CONCURRENCY` | `3` | 最大并行视觉调用数 |
| `VISION_CACHE_SIZE` | `100` | 描述缓存条目数（LRU） |
| `VISION_DEBUG` | 关 | 设为 `1` 开启调试日志 |

示例——只为 DeepSeek V4 Flash 桥接图片，不限 provider：

```bash
export VISION_ENABLE_MODELS="deepseek-v4-flash"
```

## 编写新适配器

能改写消息的宿主（OpenCode、pi）大约 100 行：

1. **收集**宿主消息格式中的 `ImageSource[]`（`{ dataUrl, context }`）
2. 调用 `bridge.describeAll(sources, hintFor?)` —— 缓存/去重/并发已处理
3. **写回**返回的 `[Image N]` 文本块到宿主消息格式
4. （可选）注册一个 re-query 工具，内部调用 `describeImage(dataUrl, question, cfg)`

不能改写出站请求的宿主（当前 Grok TUI）做不了 fast path。提供 CLI + 告诉模型去调用它的 skill 即可；除非宿主真的会读 hook stdout，否则不要把生命周期 hook 当成上下文注入通道。

## 测试

```bash
npm install
npm test
```

用例覆盖核心 / OpenCode / pi / Grok 门控：图片替换、工具截图附件、白名单/黑名单/默认门控、provider 无关的 modelID 匹配、首轮模型识别、未知模型安全、沙箱、re-query 工具、缓存/去重/重试、多图、`file://` 图片、输入路径检测、Grok DeepSeek-only 门控。所有 API 调用均为 mock——整套测试一秒内跑完。

## 实现说明

- OpenCode 消息中的图片是 `FilePart`（`type: "file"`，`mime: "image/*"`），没有专门的图片 part 类型
- `experimental.chat.messages.transform` 每次请求都收到**完整历史的深拷贝**——缓存是硬性需求
- MCP 工具返回的图片位于工具 part 的 `state.attachments`，走同一套转换管线
- 核心按内容哈希 **+ 问题**缓存——同一图片配同一问题，跨 provider、跨轮次只产生一次视觉调用；带不同问题的 re-query 绝不会命中旧的全量描述
- 当聊天模型本身支持图片时，通过配置 `VISION_SKIP_PROVIDERS` 或收窄 `VISION_ENABLE_MODELS` 保持原样
- Grok TUI：`UserPromptSubmit` 的 payload 只有 `{ prompt }`；hook stdout 仅在阻塞的 `PreToolUse` 上解析 `{ decision, reason }`。`is_cursor_harness()` 为 `false`，官方 `transcribe_user_images` 不会运行。MCP / chrome-devtools 截图和粘贴图片一样，会以内联 `image_url` 发给模型。

## License

MIT
