/**
 * Grok adapter — CLI re-query for DeepSeek-family chat models.
 *
 * Do not install as a lifecycle hook: Grok discards hook stdout.
 * Invoke via the vision-bridge skill:
 *
 *   node --experimental-strip-types src/hooks/grok.ts <path> [question]
 *
 * Default gate: model id contains "deepseek". Override with VISION_ENABLE_MODELS.
 * Cache lives on disk (each process is a fresh spawn).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DEFAULT_REQUERY_QUESTION,
  EXT_TO_MIME,
  VisionBridge,
  buildConfig,
  describeImage,
  hashKey,
  openCodeAuthKey,
} from "../core.ts"
import { resolveGrokModel, shouldDescribeGrok, skipMessage } from "./grok-gate.ts"

const IMAGE_PATH_RE =
  /(?<![A-Za-z0-9])((?:file:\/\/[^\s"'`<>]+)|(?:\/[^\s"'`<>]+\.(?:png|jpe?g|webp|gif|bmp|tiff?)))/gi

const CACHE_DIR = join(tmpdir(), "grok-vision-bridge-cache")
const ASSET_MAX_AGE_MS = 120_000

function extractImagePaths(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(IMAGE_PATH_RE)) {
    let raw = m[1]
    if (raw.startsWith("file://")) raw = fileURLToPath(raw)
    if (seen.has(raw)) continue
    seen.add(raw)
    if (existsSync(raw)) out.push(raw)
  }
  return out
}

function recentSessionAssets(sessionId: string | undefined): string[] {
  if (!sessionId) return []
  const root = join(homedir(), ".grok", "sessions")
  if (!existsSync(root)) return []
  const out: string[] = []
  const now = Date.now()
  let cwds: string[]
  try {
    cwds = readdirSync(root)
  } catch {
    return []
  }
  for (const cwd of cwds) {
    const assets = join(root, cwd, sessionId, "assets")
    const images = join(root, cwd, sessionId, "images")
    for (const dir of [assets, images]) {
      if (!existsSync(dir)) continue
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const p = join(dir, name)
        const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
        if (!EXT_TO_MIME[ext] && ext !== "tif" && ext !== "tiff") continue
        try {
          const st = statSync(p)
          if (st.isFile() && now - st.mtimeMs <= ASSET_MAX_AGE_MS) out.push(p)
        } catch {}
      }
    }
  }
  return out
}

function cacheGet(key: string): string | undefined {
  try {
    return readFileSync(join(CACHE_DIR, `${key}.txt`), "utf8")
  } catch {
    return undefined
  }
}

function cacheSet(key: string, value: string): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(join(CACHE_DIR, `${key}.txt`), value)
  } catch {}
}

function fileCacheKey(path: string): string | null {
  try {
    const st = statSync(path)
    return hashKey(`${path}:${st.size}:${st.mtimeMs}`)
  } catch {
    return null
  }
}

async function describePath(path: string, question: string, cfg: ReturnType<typeof buildConfig>): Promise<string | null> {
  const key = fileCacheKey(path)
  if (key) {
    const hit = cacheGet(key)
    if (hit) return hit
  }
  const dataUrl = VisionBridge.dataUrlFromFile(path)
  if (!dataUrl) return null
  const desc = await describeImage(dataUrl, question, cfg)
  if (desc && key) cacheSet(key, desc)
  return desc
}

function collectPaths(event: Record<string, unknown>): string[] {
  const texts: string[] = []
  for (const key of ["userPrompt", "user_prompt", "prompt"]) {
    const v = event[key]
    if (typeof v === "string") texts.push(v)
  }
  const toolResult = event.toolResult ?? event.tool_result
  if (typeof toolResult === "string") texts.push(toolResult)
  else if (toolResult != null) texts.push(JSON.stringify(toolResult))

  const seen = new Set<string>()
  const out: string[] = []
  const add = (p: string) => {
    if (seen.has(p)) return
    seen.add(p)
    out.push(p)
  }
  for (const t of texts) for (const p of extractImagePaths(t)) add(p)
  const sessionId =
    (typeof event.sessionId === "string" && event.sessionId) ||
    (typeof event.session_id === "string" && event.session_id) ||
    process.env.GROK_SESSION_ID
  for (const p of recentSessionAssets(sessionId || undefined)) add(p)
  return out
}

function eventNameOf(event: Record<string, unknown>): string {
  const raw = event.hookEventName ?? event.hook_event_name ?? "UserPromptSubmit"
  const s = String(raw)
  if (s === "user_prompt_submit" || s === "UserPromptSubmit") return "UserPromptSubmit"
  if (s === "post_tool_use" || s === "PostToolUse") return "PostToolUse"
  return s
}

async function handleHook(): Promise<void> {
  const raw = await new Promise<string>((resolve) => {
    const chunks: Buffer[] = []
    process.stdin.on("data", (c) => chunks.push(Buffer.from(c)))
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    process.stdin.on("error", () => resolve(""))
  })
  if (!raw.trim()) {
    process.exit(0)
  }
  let event: Record<string, unknown>
  try {
    event = JSON.parse(raw) as Record<string, unknown>
  } catch {
    process.exit(0)
  }

  const modelId = resolveGrokModel(process.env)
  if (!shouldDescribeGrok(modelId, process.env)) {
    process.exit(0)
  }

  const cfg = buildConfig(process.env, openCodeAuthKey)
  const paths = collectPaths(event)
  if (paths.length === 0 || !cfg.apiKey) {
    process.exit(0)
  }

  const promptText =
    (typeof event.userPrompt === "string" && event.userPrompt) ||
    (typeof event.user_prompt === "string" && event.user_prompt) ||
    ""
  const context = promptText.slice(0, 500)
  const question = context
    ? `${cfg.question}\n\nThe user's message accompanying the image: ${context}`
    : cfg.question

  const blocks: string[] = []
  for (let i = 0; i < paths.length; i++) {
    const desc = await describePath(paths[i], question, cfg)
    const label = `[Image ${i + 1}]`
    const body = desc ?? `${label} 图片已提供，但视觉服务暂不可用（可稍后用 grok.ts <path> 重试）`
    blocks.push(
      desc
        ? `${label} ${paths[i]}\n${body}\n(Original image: ${paths[i]} — if this misses a detail, run: node --experimental-strip-types ${fileURLToPath(import.meta.url)} ${paths[i]} "<question>")`
        : `${label} ${paths[i]}\n${body}`,
    )
  }

  const additionalContext = `The following images were described by a vision model because the chat model is text-only:\n\n${blocks.join("\n\n")}`
  const hookEventName = eventNameOf(event)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext },
    }),
  )
}

async function handleCli(path: string, question: string): Promise<void> {
  const modelId = resolveGrokModel(process.env)
  if (!shouldDescribeGrok(modelId, process.env)) {
    process.stderr.write(skipMessage(modelId) + "\n")
    process.exit(0)
  }
  const cfg = buildConfig(process.env, openCodeAuthKey)
  if (!existsSync(path)) {
    process.stderr.write(`Error: image file not found: ${path}\n`)
    process.exit(1)
  }
  const desc = await describePath(
    path,
    question ? DEFAULT_REQUERY_QUESTION(question) : cfg.question,
    cfg,
  )
  process.stdout.write((desc ?? "Vision model temporarily unavailable, please try again later") + "\n")
}

const cliPath = process.argv[2]
if (cliPath && cliPath !== "-" && !cliPath.startsWith("{")) {
  await handleCli(cliPath, process.argv.slice(3).join(" "))
} else {
  await handleHook()
}
