import { createHash } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { homedir, tmpdir } from "node:os"
import { extname, join, resolve, sep } from "node:path"
import { tool } from "@opencode-ai/plugin"

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

const DEFAULT_QUESTION = `The user provided this image to an AI assistant that has no vision capability. Generate a detailed text description so the assistant can fully understand the image content.
Requirements:
- Transcribe ALL visible text verbatim (UI labels, error messages, code, logs)
- Describe layout, component structure, colors, and states
- For UI screenshots: explain page structure, buttons, forms, current state
- For code/logs: transcribe the key content completely
- Output the description directly, no preamble or closing remarks`

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
    skipProviders: parseList(env.VISION_SKIP_PROVIDERS, []),
    enableModels: parseList(env.VISION_ENABLE_MODELS, []),
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
      ? `${cfg.question}\n\nThe user's message accompanying the image: ${context}`
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
          'Inspect a local image with a vision model. Use when the text description of an image in the conversation is not enough to answer the user\'s question: pass the original image path and a specific question, and the vision model will look at the actual image and answer. The path must be one previously provided as "Original image:" in the conversation.',
        args: {
          path: tool.schema.string().describe('The original image file path, as previously marked with "Original image:" in the conversation'),
          question: tool.schema.string().describe('A specific question about the image, e.g. "What is the error code on line 3?" or "What color is the button text?"'),
        },
        async execute(args) {
          const resolved = resolve(String(args.path || ""))
          if (!resolved.startsWith(resolve(SANDBOX_DIR) + sep)) {
            return 'Error: path must be a sandbox path previously provided as "Original image:"'
          }
          const ext = extname(resolved).slice(1).toLowerCase()
          const mime = EXT_TO_MIME[ext]
          if (!mime) {
            return "Error: unsupported file type, images only"
          }
          let buf
          try {
            buf = await readFile(resolved)
          } catch {
            return "Error: original image not found or already pruned (sandbox keeps at most 100 images); ask the user to re-provide the image"
          }
          const dataUrl = `data:${mime};base64,${buf.toString("base64")}`
          const question = `The user is analyzing details of an image. Focus on answering this question: ${args.question}\nRequirements: transcribe verbatim all visible text relevant to the question; be direct and precise; if nothing in the image relates to the question, state clearly "No relevant content found in the image".`
          const desc = await describeImage(dataUrl, "", cfg, log, question)
          return desc ?? "Vision model temporarily unavailable, please try again later"
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
            const label = `[Image ${idx + 1}]`
            let resolved
            try {
              resolved = await resolveImageUrl(target.part)
            } catch (error) {
              await log("error", "failed to resolve image", { error: String(error) })
              return `${label} description unavailable`
            }
            if (!resolved.url) return `${label} description unavailable`

            const filePath = await saveImageToSandbox(
              resolved.url,
              target.part.mime,
              log,
            )
            const hint = filePath
              ? `\n(Original image: ${filePath} — if the description above misses details you need, call the vision tool: pass this path as "path" and your specific question as "question".)`
              : ""

            const key = hashKey(resolved.url, resolved.mtimeMs)
            const desc = await describeOnce(key, resolved.url, target.context)
            if (desc === null) return `${label} description unavailable${hint}`
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
