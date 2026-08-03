import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { homedir, tmpdir } from "node:os"
import { extname, join, resolve, sep } from "node:path"
import { tool } from "@opencode-ai/plugin"

const DEFAULT_ENABLE_MODELS = ["deepseek-v4-flash"]

const SANDBOX_DIR = join(tmpdir(), "opencode-vision-bridge")
const SANDBOX_MAX_IMAGES = 100

const MIME_TO_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
}
const EXT_TO_MIME = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext.slice(1), mime]),
)

const DEFAULT_SKIP_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "vertex",
  "bedrock",
  "xai",
  "azure",
  "kimi-for-coding",
]

const DEFAULT_QUESTION = `用户向 AI 助手提供了这张图片，但助手没有视觉能力。请生成详细的文字描述，使助手能完全理解图片内容。
要求：
- 逐字转录图片中的所有可见文字（UI 文本、错误信息、代码、日志等）
- 描述界面布局、组件结构、颜色、状态
- 如果是界面截图：说明页面结构、按钮、表单、当前状态
- 如果是代码/日志：完整转录关键内容
- 直接输出描述，不要前言和结束语`

function parseInt_(raw, fallback, min) {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min) return fallback
  return Math.floor(n)
}

function parseList(raw, fallback) {
  if (raw === undefined) return fallback
  if (raw.trim().toLowerCase() === "none") return []
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
}

function readAuthKey(providerID) {
  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json")
    const auth = JSON.parse(readFileSync(authPath, "utf8"))
    const entry = auth[providerID]
    return typeof entry?.key === "string" ? entry.key : ""
  } catch {
    return ""
  }
}

function buildConfig(env) {
  return {
    baseUrl: (env.VISION_BASE_URL || "https://api.kimi.com/coding/v1").replace(/\/+$/, ""),
    apiKey: env.VISION_API_KEY || readAuthKey("kimi-for-coding"),
    model: env.VISION_MODEL || "k3-256k",
    question: env.VISION_QUESTION || DEFAULT_QUESTION,
    timeoutMs: parseInt_(env.VISION_TIMEOUT_MS, 120000, 1000),
    maxTokens: parseInt_(env.VISION_MAX_TOKENS, 2048, 1),
    maxConcurrency: parseInt_(env.VISION_MAX_CONCURRENCY, 3, 1),
    cacheSize: parseInt_(env.VISION_CACHE_SIZE, 100, 0),
    skipProviders: parseList(env.VISION_SKIP_PROVIDERS, [...DEFAULT_SKIP_PROVIDERS]),
    enableModels: parseList(env.VISION_ENABLE_MODELS, [...DEFAULT_ENABLE_MODELS]),
    debug: env.VISION_DEBUG === "1",
  }
}

function isImageFilePart(part) {
  return (
    part &&
    typeof part === "object" &&
    part.type === "file" &&
    typeof part.mime === "string" &&
    part.mime.startsWith("image/") &&
    typeof part.url === "string"
  )
}

function extractActiveModel(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const model = messages[i]?.info?.model
    const providerID = model?.providerID
    const modelID = model?.modelID
    if (typeof providerID === "string" && providerID) {
      return {
        provider: providerID.toLowerCase(),
        modelId: typeof modelID === "string" ? `${providerID.toLowerCase()}/${modelID.toLowerCase()}` : undefined,
      }
    }
  }
  return { provider: undefined, modelId: undefined }
}

function modelMatches(entry, modelId) {
  if (!modelId) return false
  if (entry.includes("/")) return entry === modelId
  return modelId.split("/")[1] === entry
}

function shouldProcess(sessionModelId, messages, cfg) {
  const modelId = sessionModelId || extractActiveModel(messages).modelId
  if (cfg.enableModels.length > 0) {
    return cfg.enableModels.some((entry) => modelMatches(entry, modelId))
  }
  const provider = modelId?.split("/")[0] || extractActiveModel(messages).provider
  if (!provider) return true
  return !cfg.skipProviders.includes(provider)
}

function hashKey(url, mtimeMs) {
  const h = createHash("sha256")
  h.update(url)
  if (mtimeMs !== undefined) h.update(String(mtimeMs))
  return h.digest("hex")
}

async function resolveImageUrl(part) {
  const url = part.url
  if (url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")) {
    return { url, mtimeMs: undefined }
  }
  let filePath
  if (url.startsWith("file://")) {
    filePath = fileURLToPath(url)
  } else if (url.startsWith("/")) {
    filePath = url
  } else {
    return { url: undefined, mtimeMs: undefined }
  }
  const [buf, st] = await Promise.all([readFile(filePath), stat(filePath)])
  const mime = part.mime || "image/png"
  return { url: `data:${mime};base64,${buf.toString("base64")}`, mtimeMs: st.mtimeMs }
}

async function pruneSandbox(log) {
  try {
    const entries = await readdir(SANDBOX_DIR)
    if (entries.length <= SANDBOX_MAX_IMAGES) return
    const withTime = await Promise.all(
      entries.map(async (name) => {
        try {
          const st = await stat(join(SANDBOX_DIR, name))
          return { name, mtimeMs: st.mtimeMs }
        } catch {
          return { name, mtimeMs: 0 }
        }
      }),
    )
    withTime.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const toDelete = withTime.slice(0, withTime.length - SANDBOX_MAX_IMAGES)
    await Promise.all(toDelete.map((e) => unlink(join(SANDBOX_DIR, e.name)).catch(() => {})))
    await log("debug", "sandbox pruned", { deleted: toDelete.length })
  } catch {}
}

async function saveImageToSandbox(url, mime, log) {
  const ext = MIME_TO_EXT[mime] || ".png"
  const name = `${hashKey(url)}${ext}`
  const filePath = join(SANDBOX_DIR, name)
  try {
    const existing = await stat(filePath).catch(() => null)
    if (existing?.isFile()) return filePath

    await mkdir(SANDBOX_DIR, { recursive: true })
    if (url.startsWith("data:")) {
      const base64 = url.slice(url.indexOf(",") + 1)
      await writeFile(filePath, Buffer.from(base64, "base64"))
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      const res = await fetch(url)
      if (!res.ok) {
        await log("warn", "sandbox download failed", { status: res.status })
        return null
      }
      await writeFile(filePath, Buffer.from(await res.arrayBuffer()))
    } else {
      return null
    }
    void pruneSandbox(log)
    return filePath
  } catch (error) {
    await log("warn", "sandbox save failed", { error: String(error) })
    return null
  }
}

function contextOfMessage(message) {
  const parts = message?.parts
  if (!Array.isArray(parts)) return ""
  const texts = []
  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string") texts.push(part.text)
  }
  return texts.join("\n").slice(0, 500)
}

function recentUserText(messages, beforeIndex) {
  for (let i = Math.min(beforeIndex, messages.length - 1); i >= 0; i--) {
    if (messages[i]?.info?.role !== "user") continue
    const text = contextOfMessage(messages[i])
    if (text) return text
  }
  return ""
}

function collectTargets(messages) {
  const targets = []
  for (let mi = 0; mi < messages.length; mi++) {
    const message = messages[mi]
    const parts = message?.parts
    if (!Array.isArray(parts)) continue
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi]
      if (isImageFilePart(part)) {
        targets.push({
          kind: "part",
          parts,
          index: pi,
          part,
          context: contextOfMessage(message),
        })
        continue
      }
      if (part?.type === "tool") {
        const state = part.state
        const attachments = state?.attachments
        if (state?.status === "completed" && Array.isArray(attachments)) {
          for (let ai = 0; ai < attachments.length; ai++) {
            if (isImageFilePart(attachments[ai])) {
              targets.push({
                kind: "attachment",
                toolPart: part,
                index: ai,
                part: attachments[ai],
                context: recentUserText(messages, mi - 1),
              })
            }
          }
        }
      }
    }
  }
  return targets
}

async function describeImage(imageUrl, context, cfg, log, overrideQuestion) {
  if (!cfg.baseUrl) {
    await log("error", "vision base URL not configured", {})
    return null
  }
  if (!cfg.apiKey) {
    await log("error", "vision API key not configured", {})
    return null
  }

  const question =
    overrideQuestion ||
    (context
      ? `${cfg.question}\n\n用户随图片发送的消息：${context}`
      : cfg.question)

  const body = {
    model: cfg.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: question },
        ],
      },
    ],
    max_tokens: cfg.maxTokens,
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (res.status >= 500 && attempt === 0) {
        await log("warn", "vision 5xx, retrying", { status: res.status })
        continue
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        await log("error", "vision request failed", { status: res.status, body: text.slice(0, 300) })
        break
      }
      const parsed = await res.json().catch(() => null)
      const content = parsed?.choices?.[0]?.message?.content
      if (typeof content === "string" && content.trim()) return content.trim()
      await log("error", "vision unexpected response shape", {})
      break
    } catch (error) {
      clearTimeout(timer)
      const isAbort = error instanceof Error && error.name === "AbortError"
      if (isAbort && attempt === 0) {
        await log("warn", "vision timeout, retrying", { timeoutMs: cfg.timeoutMs })
        continue
      }
      await log("error", "vision call error", { error: String(error) })
      break
    }
  }
  return null
}

async function withConcurrency(tasks, limit) {
  const results = new Array(tasks.length)
  let next = 0
  const workerCount = Math.max(1, Math.min(limit, tasks.length))
  async function worker() {
    while (true) {
      const i = next++
      if (i >= tasks.length) return
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize
    this.store = new Map()
  }
  get(key) {
    const v = this.store.get(key)
    if (v === undefined) return undefined
    this.store.delete(key)
    this.store.set(key, v)
    return v
  }
  set(key, value) {
    if (this.maxSize <= 0) return
    if (this.store.has(key)) this.store.delete(key)
    this.store.set(key, value)
    while (this.store.size > this.maxSize) {
      const oldest = this.store.keys().next().value
      if (oldest === undefined) break
      this.store.delete(oldest)
    }
  }
}

function makeLogger(client, debug) {
  const logFn = client?.app?.log
  return async (level, message, extra = {}) => {
    if (level === "debug" && !debug) return
    if (typeof logFn !== "function") return
    try {
      await logFn({ body: { service: "vision-bridge", level, message, extra } })
    } catch {}
  }
}

const VisionBridgePlugin = async ({ client }) => {
  const cfg = buildConfig(process.env)
  const log = makeLogger(client, cfg.debug)
  const cache = new LRUCache(cfg.cacheSize)

  await log("info", "vision-bridge initialized", {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasKey: Boolean(cfg.apiKey),
    skipProviders: cfg.skipProviders,
    enableModels: cfg.enableModels,
  })

  const inflight = new Map()
  const sessionModels = new Map()

  function rememberSessionModel(sessionID, model) {
    if (!sessionID) return
    const providerID = model?.providerID
    const modelID = model?.modelID
    if (typeof providerID !== "string" || typeof modelID !== "string") return
    sessionModels.delete(sessionID)
    sessionModels.set(sessionID, `${providerID.toLowerCase()}/${modelID.toLowerCase()}`)
    while (sessionModels.size > 200) {
      const oldest = sessionModels.keys().next().value
      if (oldest === undefined) break
      sessionModels.delete(oldest)
    }
  }

  function sessionIdOf(messages) {
    for (const message of messages) {
      const fromInfo = message?.info?.sessionID
      if (typeof fromInfo === "string" && fromInfo) return fromInfo
      const parts = message?.parts
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (typeof part?.sessionID === "string" && part.sessionID) return part.sessionID
        }
      }
    }
    return undefined
  }

  async function describeOnce(key, url, context) {
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    let promise = inflight.get(key)
    if (!promise) {
      promise = describeImage(url, context, cfg, log).then((desc) => {
        if (desc !== null) cache.set(key, desc)
        inflight.delete(key)
        return desc
      })
      inflight.set(key, promise)
    }
    return promise
  }

  return {
    "chat.params": async (input) => {
      try {
        rememberSessionModel(input?.sessionID, input?.model)
      } catch {}
    },
    tool: {
      vision: tool({
        description:
          "查看一张本地图片的内容。当消息中的图像文字描述不足以回答用户的问题时使用：传入原图路径和针对图片的具体问题，视觉模型会定向查看原图并回答。path 必须是之前消息中以「原图：」标注的路径。",
        args: {
          path: tool.schema.string().describe("原图文件路径，即消息中「原图：」后标注的沙箱路径"),
          question: tool.schema.string().describe("针对图片的具体问题，例如「第 3 行的错误码是什么」「按钮上的文字是什么颜色」"),
        },
        async execute(args) {
          const resolved = resolve(String(args.path || ""))
          if (!resolved.startsWith(resolve(SANDBOX_DIR) + sep)) {
            return "错误：path 必须是消息中「原图：」标注的沙箱路径"
          }
          const ext = extname(resolved).slice(1).toLowerCase()
          const mime = EXT_TO_MIME[ext]
          if (!mime) {
            return "错误：不支持的文件类型，仅允许图片"
          }
          let buf
          try {
            buf = await readFile(resolved)
          } catch {
            return "错误：原图不存在或已被清理（沙箱最多保留 100 张），请让用户重新提供图片"
          }
          const dataUrl = `data:${mime};base64,${buf.toString("base64")}`
          const question = `用户在分析一张图片的细节。请聚焦回答以下问题：${args.question}\n要求：逐字转录与问题相关的所有可见文字；回答直接精确；若图中没有与问题相关的内容，明确说明「图中未找到相关信息」。`
          const desc = await describeImage(dataUrl, "", cfg, log, question)
          return desc ?? "视觉模型暂时不可用，请稍后再试"
        },
      }),
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output?.messages
      if (!Array.isArray(messages)) return
      try {
        const sessionModelId = sessionModels.get(sessionIdOf(messages))
        if (!shouldProcess(sessionModelId, messages, cfg)) return
        const targets = collectTargets(messages)
        if (targets.length === 0) return

        const descriptions = await withConcurrency(
          targets.map((target, idx) => async () => {
            const label = `[图像 ${idx + 1}]`
            let resolved
            try {
              resolved = await resolveImageUrl(target.part)
            } catch (error) {
              await log("error", "failed to resolve image", { error: String(error) })
              return `${label} 描述不可用`
            }
            if (!resolved.url) return `${label} 描述不可用`

            const filePath = await saveImageToSandbox(
              resolved.url,
              target.part.mime,
              log,
            )
            const hint = filePath
              ? `\n（原图：${filePath} — 若上述描述未覆盖你需要的细节，可调用 vision 工具：path 传该路径，question 传具体问题，可进一步查看原图）`
              : ""

            const key = hashKey(resolved.url, resolved.mtimeMs)
            const desc = await describeOnce(key, resolved.url, target.context)
            if (desc === null) return `${label} 描述不可用${hint}`
            return `${label}\n${desc}${hint}`
          }),
          cfg.maxConcurrency,
        )

        for (let i = 0; i < targets.length; i++) {
          const target = targets[i]
          const text = descriptions[i]
          if (target.kind === "part") {
            target.parts[target.index] = { type: "text", text }
          } else {
            const state = target.toolPart.state
            state.output = `${state.output}\n\n${text}`
          }
        }

        const touchedToolParts = new Set(
          targets.filter((t) => t.kind === "attachment").map((t) => t.toolPart),
        )
        for (const toolPart of touchedToolParts) {
          const attachments = toolPart.state.attachments
          if (Array.isArray(attachments)) {
            const remaining = attachments.filter((a) => !isImageFilePart(a))
            if (remaining.length === 0) {
              delete toolPart.state.attachments
            } else {
              toolPart.state.attachments = remaining
            }
          }
        }

        await log("info", "replaced images with descriptions", { count: targets.length })
      } catch (error) {
        await log("error", "transform failed", { error: String(error) })
      }
    },
  }
}

export default VisionBridgePlugin
