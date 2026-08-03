# opencode-vision-bridge

> 让不支持视觉的模型（DeepSeek 等）在 [OpenCode](https://opencode.ai) 里"看见"图片——自动、无感、无需切换模型。
> Give text-only models (e.g. DeepSeek) image understanding in OpenCode — transparently, without switching models.

## 解决什么问题

在 OpenCode 里给纯文本模型（如 `deepseek-v4-flash`）发图片，会直接报错 `this model does not support image input`。本插件在消息到达模型**之前**拦截图片，调用视觉模型生成文字描述并原地替换——主模型从头到尾不切换，收到的就是纯文字。

与同类插件的区别：**双层架构**。

```
你发图/截图
    │
    ▼
experimental.chat.messages.transform（本插件）
    │  ① 快路径：视觉模型生成描述，原地替换图片为文字
    │  ② 原图存入本地沙箱，替换文本附带路径
    ▼
主模型（DeepSeek）收到纯文字，正常回答
    │  若描述未覆盖它需要的细节（"第 3 行错误码是什么"）
    ▼
主模型自主调用 vision 工具 → 视觉模型带着具体问题回查原图
```

- **快路径**：一次性摘要，覆盖"这图是什么"类场景，零额外往返
- **回查路径**：原图永远可用，模型按需带问题定向提取，可迭代逼近无损

## 特性

- **完全无感**：上传图片、浏览器截图（MCP 工具返回的图片附件）都自动处理，不需要任何手动操作
- **主模型不变**：视觉模型只是后台"翻译器"，会话模型从头到尾不变
- **精确生效范围**：默认只对 `deepseek-v4-flash` 生效（按 modelID 匹配，**provider 无关**——直连、OpenCode Go、任意网关都行），其他模型一律原样放行
- **会话第一轮即可用**：通过 `chat.params` 钩子识别当前模型，不依赖 assistant 消息
- **内容 hash 缓存 + 并发去重**：同一张图在会话中只识别一次
- **失败静默降级**：视觉 API 挂了对对话零阻塞（错误不缓存，下轮自动重试）
- **安全**：`vision` 工具沙箱校验，只能读插件自己存的原图

## 安装

把 `vision-bridge.js` 复制到 OpenCode 全局插件目录，重启 OpenCode：

```bash
cp vision-bridge.js ~/.config/opencode/plugins/
```

默认走 `kimi-for-coding/k3-256k` 做视觉模型（自动读取 OpenCode `auth.json` 里的 key，零配置）。换其他 OpenAI 兼容端点见下方环境变量。

## 配置（环境变量，均有默认值）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VISION_BASE_URL` | `https://api.kimi.com/coding/v1` | OpenAI 兼容端点 |
| `VISION_MODEL` | `k3-256k` | 视觉模型 |
| `VISION_API_KEY` | 读 `auth.json` 的 `kimi-for-coding` | 显式指定可覆盖 |
| `VISION_ENABLE_MODELS` | `deepseek-v4-flash` | 生效白名单，逗号分隔。条目含 `/` 精确匹配 `provider/model`；不含 `/` 只比 modelID（provider 无关） |
| `VISION_SKIP_PROVIDERS` | `anthropic,openai,google,…` | 白名单为空时按 provider 黑名单放行 |
| `VISION_TIMEOUT_MS` | `120000` | 单次视觉调用超时（失败重试一次） |
| `VISION_MAX_TOKENS` | `2048` | 描述最大 token |
| `VISION_MAX_CONCURRENCY` | `3` | 并发上限 |
| `VISION_CACHE_SIZE` | `100` | 描述缓存条数 |
| `VISION_DEBUG` | 关 | `1` 开启 debug 日志 |

## 测试

```bash
npm test
```

15 个用例覆盖：上传图片替换、截图附件处理、provider 无关匹配、第一轮识别、模型未知安全不动、沙箱存盘与拦截、vision 工具定向回查、缓存/并发去重/失败重试、多图、`file://` 本地图。全部 mock API，秒级跑完。

## 原理备忘

- 图片在 OpenCode 消息里是 `FilePart`（`type:"file"`, `mime:"image/*"`），没有独立的 image part
- `experimental.chat.messages.transform` 拿到的是消息历史的**深拷贝**，每轮请求都会重新触发——所以缓存是硬需求
- 工具（MCP）返回的图片在 `tool part` 的 `state.attachments` 里，统一走同一条 transform 管道
- 主模型支持视觉时插件完全不介入（配 `VISION_ENABLE_MODELS` 精确控制）

## License

MIT
