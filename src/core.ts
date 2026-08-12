/**
 * vision-bridge core — host-agnostic minimal core.
 *
 * Zero dependencies on any host SDK (OpenCode / pi / ...). Hosts only need to:
 *   1. collect image sources from their message format
 *   2. call `bridge.describeAll(...)`
 *   3. write the resulting text back into their message format
 *
 * All configuration comes from env vars (VISION_*), see buildConfig().
 */
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"

export const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
}

export const DEFAULT_QUESTION = `The user provided this image to an AI assistant that has no vision capability. Generate a detailed text description so the assistant can fully understand the image content.
Requirements:
- Transcribe ALL visible text verbatim (UI labels, error messages, code, logs)
- Describe layout, component structure, colors, and states
- For UI screenshots: explain page structure, buttons, forms, current state
- For code/logs: transcribe the key content completely
- Output the description directly, no preamble or closing remarks`

export const DEFAULT_REQUERY_QUESTION = (question: string) =>
  `The user is analyzing details of an image. Focus on answering this question: ${question}\nRequirements: transcribe verbatim all visible text relevant to the question; be direct and precise; if nothing in the image relates to the question, state clearly "No relevant content found in the image".`

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BridgeConfig {
  baseUrl: string
  apiKey: string
  model: string
  question: string
  timeoutMs: number
  maxTokens: number
  maxConcurrency: number
  cacheSize: number
  debug: boolean
}

export interface KeyProvider {
  (providerID: string): string
}

/** Default key source: OpenCode's auth.json (kimi-for-coding). Override with VISION_API_KEY. */
export function openCodeAuthKey(providerID: string): string {
  try {
    const auth = JSON.parse(
      readFileSync(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8"),
    ) as Record<string, { key?: string }>
    const entry = auth[providerID]
    return typeof entry?.key === "string" ? entry.key : ""
  } catch {
    return ""
  }
}

type EnvValue = string | number | undefined

function parseInt_(raw: EnvValue, fallback: number, min: number): number {
  if (raw === undefined) return fallback
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback
  if (raw.trim() === "") return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min) return fallback
  return Math.floor(n)
}

/** Build config from env. `readKey` is injectable for testing; defaults to OpenCode auth.json. */
export function buildConfig(
  env: Record<string, EnvValue> = process.env,
  readKey: KeyProvider = openCodeAuthKey,
): BridgeConfig {
  return {
    baseUrl: (env.VISION_BASE_URL || "https://api.kimi.com/coding/v1").replace(/\/+$/, ""),
    apiKey: env.VISION_API_KEY || readKey("kimi-for-coding"),
    model: env.VISION_MODEL || "k3-256k",
    question: env.VISION_QUESTION || DEFAULT_QUESTION,
    timeoutMs: parseInt_(env.VISION_TIMEOUT_MS, 120000, 1000),
    maxTokens: parseInt_(env.VISION_MAX_TOKENS, 2048, 1),
    maxConcurrency: parseInt_(env.VISION_MAX_CONCURRENCY, 3, 1),
    cacheSize: parseInt_(env.VISION_CACHE_SIZE, 100, 0),
    debug: env.VISION_DEBUG === "1",
  }
}

// ---------------------------------------------------------------------------
// Vision API call
// ---------------------------------------------------------------------------

/** Describe one image. Returns null on any failure (never throws). Not cached here. */
export async function describeImage(
  imageUrl: string,
  question: string,
  cfg: BridgeConfig,
): Promise<string | null> {
  if (!cfg.baseUrl || !cfg.apiKey) return null

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

      if (res.status >= 500 && attempt === 0) continue
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        console.error(`[vision-bridge] request failed: ${res.status} ${text.slice(0, 300)}`)
        break
      }
      const parsed = (await res.json().catch(() => null)) as {
        choices?: { message?: { content?: string } }[]
      }
      const content = parsed?.choices?.[0]?.message?.content
      if (typeof content === "string" && content.trim()) return content.trim()
      break
    } catch (error) {
      clearTimeout(timer)
      const isAbort = error instanceof Error && error.name === "AbortError"
      if (isAbort && attempt === 0) continue
      console.error(`[vision-bridge] call error: ${String(error)}`)
      break
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Cache + dedup + concurrency
// ---------------------------------------------------------------------------

export class LRUCache {
  private store = new Map<string, string>()
  private maxSize: number
  constructor(maxSize: number) {
    this.maxSize = maxSize
  }
  get(key: string): string | undefined {
    const v = this.store.get(key)
    if (v === undefined) return undefined
    this.store.delete(key)
    this.store.set(key, v)
    return v
  }
  set(key: string, value: string): void {
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

export function hashKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16)
}

export async function withConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length)
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

// ---------------------------------------------------------------------------
// Bridge: the one class hosts interact with
// ---------------------------------------------------------------------------

export interface ImageSource {
  /** data: URL of the image */
  dataUrl: string
  /** Accompanying user text, used to give the vision model context */
  context?: string
}

export interface DescribeResult {
  /** e.g. "[Image 1]" */
  label: string
  /** The description text, or a graceful-unavailable message */
  text: string
  /** Optional extra hint appended after the description (e.g. original image path) */
  hint?: string
}

export const UNAVAILABLE = (label: string) => `${label} 图片已提供，但视觉服务暂不可用（可稍后重试）`

/**
 * Host-agnostic bridge. Handles caching, in-flight dedup and concurrency.
 * Errors are never cached, so a failed turn retries automatically next time.
 */
export class VisionBridge {
  private cache: LRUCache
  private inflight = new Map<string, Promise<string | null>>()
  readonly config: BridgeConfig

  constructor(config: BridgeConfig) {
    this.config = config
    this.cache = new LRUCache(config.cacheSize)
  }

  /** Describe one image with an explicit question. Cached by content hash. */
  describeOne(dataUrl: string, question: string): Promise<string | null> {
    if (!dataUrl) return Promise.resolve(null)
    const key = hashKey(dataUrl)
    const cached = this.cache.get(key)
    if (cached !== undefined) return Promise.resolve(cached)
    let promise = this.inflight.get(key)
    if (!promise) {
      promise = describeImage(dataUrl, question, this.config)
        .then((desc) => {
          this.inflight.delete(key)
          if (desc !== null) this.cache.set(key, desc)
          return desc
        })
        .catch(() => {
          this.inflight.delete(key)
          return null
        })
      this.inflight.set(key, promise)
    }
    return promise
  }

  /**
   * Describe many images concurrently, producing labeled result blocks.
   * `hintFor` lets the host append per-image extra info (e.g. a sandbox path
   * the model can re-query later).
   */
  async describeAll(
    sources: ImageSource[],
    hintFor?: (source: ImageSource, index: number) => string | undefined,
  ): Promise<DescribeResult[]> {
    if (sources.length === 0) return []
    const withHint = (index: number) => {
      const hint = hintFor?.(sources[index], index)
      return hint ? `\n${hint}` : ""
    }
    const results = await withConcurrency(
      sources.map((s, i) => async () => {
        const label = `[Image ${i + 1}]`
        const question = s.context
          ? `${this.config.question}\n\nThe user's message accompanying the image: ${s.context}`
          : this.config.question
        const desc = await this.describeOne(s.dataUrl, question)
        if (desc === null) return { label, text: `${label} description unavailable`, hint: withHint(i) }
        return { label, text: `${label}\n${desc}`, hint: withHint(i) }
      }),
      this.config.maxConcurrency,
    )
    return results
  }

  /** Helper: build a data: URL from raw base64 + mime */
  static dataUrlFromBase64(base64: string, mime: string): string {
    return base64.startsWith("data:") ? base64 : `data:${mime || "image/png"};base64,${base64}`
  }

  /** Helper: read a local file into a data: URL (returns null on failure) */
  static dataUrlFromFile(path: string, mime?: string): string | null {
    try {
      const m = mime || EXT_TO_MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()]
      if (!m) return null
      return `data:${m};base64,${readFileSync(path).toString("base64")}`
    } catch {
      return null
    }
  }
}
