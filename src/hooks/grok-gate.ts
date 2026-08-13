/**
 * Grok-only model gate. Default: DeepSeek family only.
 * VISION_ENABLE_MODELS, when set, replaces the default (same meaning as OpenCode).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function parseList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "" || raw.trim().toLowerCase() === "none") return []
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function modelMatches(entry: string, modelId: string): boolean {
  const id = modelId.toLowerCase()
  const e = entry.toLowerCase()
  if (e.includes("/")) return e === id
  return id === e || id.endsWith(`/${e}`)
}

export function isDeepSeekFamily(modelId: string | undefined): boolean {
  return typeof modelId === "string" && modelId.toLowerCase().includes("deepseek")
}

/** Grok default = DeepSeek only. VISION_ENABLE_MODELS is an explicit allowlist. */
export function shouldDescribeGrok(modelId: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const enable = parseList(env.VISION_ENABLE_MODELS)
  if (enable.length > 0) {
    if (!modelId) return false
    return enable.some((entry) => modelMatches(entry, modelId))
  }
  return isDeepSeekFamily(modelId)
}

export function readConfigDefaultModel(configText: string): string | undefined {
  const section = configText.match(/\[models\]([\s\S]*?)(?=\n\[|\n*$)/)
  if (!section) return undefined
  const m = section[1].match(/^\s*default\s*=\s*"([^"]+)"/m)
  return m?.[1]
}

export function readSessionModelId(summaryJson: string): string | undefined {
  try {
    const parsed = JSON.parse(summaryJson) as { current_model_id?: unknown }
    return typeof parsed.current_model_id === "string" ? parsed.current_model_id : undefined
  } catch {
    return undefined
  }
}

function sessionsRoot(): string {
  return join(homedir(), ".grok", "sessions")
}

function modelFromSummaryFile(file: string): string | undefined {
  try {
    return readSessionModelId(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

export function findSessionModel(sessionId: string | undefined, root = sessionsRoot()): string | undefined {
  if (!sessionId || !existsSync(root)) return undefined
  let cwds: string[]
  try {
    cwds = readdirSync(root)
  } catch {
    return undefined
  }
  for (const cwd of cwds) {
    const file = join(root, cwd, sessionId, "summary.json")
    const id = modelFromSummaryFile(file)
    if (id) return id
  }
  return undefined
}

/** Newest session under the encoded cwd folder (Grok stores sessions as encodeURIComponent(cwd)). */
export function findNewestCwdModel(cwd: string, root = sessionsRoot()): string | undefined {
  const dir = join(root, encodeURIComponent(cwd))
  if (!existsSync(dir)) return undefined
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  let best: { mtime: number; id: string } | undefined
  for (const name of names) {
    const file = join(dir, name, "summary.json")
    if (!existsSync(file)) continue
    const id = modelFromSummaryFile(file)
    if (!id) continue
    let mtime = 0
    try {
      mtime = statSync(file).mtimeMs
    } catch {}
    if (!best || mtime > best.mtime) best = { mtime, id }
  }
  return best?.id
}

export function resolveGrokModel(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string | undefined {
  const fromEnv = env.VISION_GROK_MODEL || env.GROK_MODEL
  if (fromEnv) return fromEnv
  const fromSession = findSessionModel(env.GROK_SESSION_ID)
  if (fromSession) return fromSession
  const fromNewest = findNewestCwdModel(cwd)
  if (fromNewest) return fromNewest
  try {
    const text = readFileSync(join(homedir(), ".grok", "config.toml"), "utf8")
    return readConfigDefaultModel(text)
  } catch {
    return undefined
  }
}

export function skipMessage(modelId: string | undefined): string {
  const shown = modelId ?? "(unknown)"
  return `[vision-bridge] skipped: chat model '${shown}' is outside the Grok describe allowlist (DeepSeek-family by default; override with VISION_ENABLE_MODELS or VISION_GROK_MODEL).`
}
