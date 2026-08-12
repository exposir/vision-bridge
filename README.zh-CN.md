# vision-bridge

让纯文本模型（如 DeepSeek）拥有图像理解能力——无需切换模型，完全透明。

图片在到达纯文本模型**之前**被拦截，发送给视觉模型生成文字描述，并原地替换为文本。对话模型始终不变——它收到的只是文字。

**宿主无关的核心 + 轻量适配器。** 桥接逻辑（视觉调用、缓存、去重、并发）全部在 `src/core.ts` 中，零宿主依赖；每个宿主只需一个薄适配器，把宿主的消息格式映射到核心上。

```
你粘贴 / 截图一张图片
        │
        ▼
宿主适配器 (opencode / pi)
        │  ① fast path：视觉模型描述图片，
        │     图片被原地替换为文字
        │  ② (opencode) 原图保存到本地沙箱，
        │     替换文本携带其路径
        ▼
聊天模型（如 DeepSeek）收到纯文本并回答
        │  如果描述缺少它需要的细节
        │  （"第 3 行的错误码是什么？"）
        ▼
聊天模型自行调用 re-query 工具 →
视觉模型带着那个具体问题重新审视原图
```

- **Fast path**：一次性摘要，覆盖"这是什么图"场景，零额外往返
- **Re-query path**：原图始终可用，模型按需提出针对性问题，迭代逼近无损

## 目录结构

```
src/
├── core.ts              # 宿主无关核心：配置、视觉调用、LRU 缓存、
│                        #   in-flight 去重、并发（零宿主 import）
├── hooks/
│   ├── opencode.ts      # OpenCode 适配器（messages.transform + vision 工具）
│   └── pi.ts            # pi 适配器（input 事件 + view_image 工具）
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

之后在 pi 里执行 `/reload`。除粘贴的图片外，pi 适配器还会自动识别输入文本中的图片**文件路径**（如 `pi-clipboard-*.png`）并描述它们。

### 配置（环境变量，全部可选）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VISION_BASE_URL` | `https://api.kimi.com/coding/v1` | OpenAI 兼容端点 |
| `VISION_MODEL` | `k3-256k` | 视觉模型 id |
| `VISION_API_KEY` | `~/.local/share/opencode/auth.json` 中 `kimi-for-coding` 的 key | 显式覆盖 |
| `VISION_QUESTION` | 内置英文提示词 | 图片描述使用的提示词 |
| `VISION_ENABLE_MODELS` | _(空 = 所有模型)_ | 逗号分隔白名单。含 `/` 的条目精确匹配 `provider/model`；裸条目按 modelID 匹配、不限 provider |
| `VISION_SKIP_PROVIDERS` | _(空 = 不跳过)_ | 逗号分隔 provider 黑名单，仅在白名单为空时生效 |
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

适配器大约 100 行。需要做到：

1. **收集**宿主消息格式中的 `ImageSource[]`（`{ dataUrl, context }`）
2. 调用 `bridge.describeAll(sources, hintFor?)` —— 缓存/去重/并发已处理
3. **写回**返回的 `[Image N]` 文本块到宿主消息格式
4. （可选）注册一个 re-query 工具，内部调用 `describeImage(dataUrl, question, cfg)`

## 测试

```bash
npm install
npm test
```

35 个用例，覆盖核心 / OpenCode 适配器 / pi 适配器：图片替换、工具截图附件、白名单/黑名单/默认门控、provider 无关的 modelID 匹配、首轮模型识别、未知模型安全、沙箱、re-query 工具、缓存/去重/重试、多图、`file://` 图片、输入路径检测。所有 API 调用均为 mock——整套测试一秒内跑完。

## 实现说明

- OpenCode 消息中的图片是 `FilePart`（`type: "file"`，`mime: "image/*"`），没有专门的图片 part 类型
- `experimental.chat.messages.transform` 每次请求都收到**完整历史的深拷贝**——缓存是硬性需求
- MCP 工具返回的图片位于工具 part 的 `state.attachments`，走同一套转换管线
- 核心按内容哈希缓存，跨 provider、跨轮次的相同图片只产生一次视觉调用
- 当聊天模型本身支持图片时，通过配置 `VISION_SKIP_PROVIDERS` 或收窄 `VISION_ENABLE_MODELS` 保持原样

## License

MIT
