/**
 * OpenCode adapter — wires the vision-bridge core into OpenCode's
 * `experimental.chat.messages.transform` hook + a `vision` re-query tool.
 *
 * Install (OpenCode): copy the bundled dist/opencode-plugin.js (or this file
 * plus src/core.ts) into ~/.config/opencode/plugins/ and restart OpenCode.
 */
import { copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { tool } from "@opencode-ai/plugin"
import {
  EXT_TO_MIME,
  VisionBridge,
  buildConfig,
  buildModelGate,
  describeImage,
  gateAllows,
  hashKey,
  openCodeAuthKey,
} from "../core.ts"
import { DEFAULT_REQUERY_QUESTION } from "../core.ts"
import type { ImageSource } from "../core.ts"

const SANDBOX_DIR = join(tmpdir(), "opencode-vision-bridge")
const SANDBOX_MAX_IMAGES = 100

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
}

function isImageFilePart(part: any): boolean {
  return (
    part &&
    typeof part === "object" &&
    part.type === "file" &&
    typeof part.mime === "string" &&
    part.mime.startsWith("image/") &&
    typeof part.url === "string"
  )
}

function extractActiveModel(messages: any[]): { provider?: string; modelId?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const model = messages[i]?.info?.model
    const providerID = model?.providerID
    const modelID = model?.modelID
    if (typeof providerID === "string" && providerID) {
      return {
        provider: providerID.toLowerCase(),
        modelId:
          typeof modelID === "string"
            ? `${providerID.toLowerCase()}/${modelID.toLowerCase()}`
            : undefined,
      }
    }
  }
  return { provider: undefined, modelId: undefined }
}

// --- sandbox: where re-queryable originals are kept ------------------------

async function pruneSandbox(log: any): Promise<void> {
  try {
    const entries = await readdir(SANDBOX_DIR)
    if (entries.length <= SANDBOX_MAX_IMAGES) return
    const withTime = await Promise.all(
      entries.map(async (name: string) => {
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

async function saveImageToSandbox(url: string, mime: string, log: any): Promise<string | null> {
  const ext = MIME_TO_EXT[mime] || ".png"
  const filePath = join(SANDBOX_DIR, `${hashKey(url)}${ext}`)
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

// --- message scanning -------------------------------------------------------

function contextOfMessage(message: any): string {
  const parts = message?.parts
  if (!Array.isArray(parts)) return ""
  const texts: string[] = []
  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string") texts.push(part.text)
  }
  return texts.join("\n").slice(0, 500)
}

function recentUserText(messages: any[], beforeIndex: number): string {
  for (let i = Math.min(beforeIndex, messages.length - 1); i >= 0; i--) {
    if (messages[i]?.info?.role !== "user") continue
    const text = contextOfMessage(messages[i])
    if (text) return text
  }
  return ""
}

async function resolveImageUrl(part: any): Promise<{ url?: string; mtimeMs?: number }> {
  const url = part.url
  if (url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")) {
    return { url, mtimeMs: undefined }
  }
  let filePath: string
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

interface Target {
  kind: "part" | "attachment"
  parts?: any[]
  index: number
  part: any
  toolPart?: any
  context: string
}

function collectTargets(messages: any[]): Target[] {
  const targets: Target[] = []
  for (let mi = 0; mi < messages.length; mi++) {
    const message = messages[mi]
    const parts = message?.parts
    if (!Array.isArray(parts)) continue
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi]
      if (isImageFilePart(part)) {
        targets.push({ kind: "part", parts, index: pi, part, context: contextOfMessage(message) })
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

// --- plugin -----------------------------------------------------------------

function makeLogger(client: any, debug: boolean) {
  const logFn = client?.app?.log
  return async (level: string, message: string, extra: Record<string, unknown> = {}) => {
    if (level === "debug" && !debug) return
    if (typeof logFn !== "function") return
    try {
      await logFn({ body: { service: "vision-bridge", level, message, extra } })
    } catch {}
  }
}

const VisionBridgePlugin = async ({ client }: { client?: any }) => {
  const env = process.env as Record<string, string | undefined>
  const gate = buildModelGate(env)
  const bridge = new VisionBridge(buildConfig(env, openCodeAuthKey))
  const log = makeLogger(client, bridge.config.debug)

  await log("info", "vision-bridge initialized", {
    baseUrl: bridge.config.baseUrl,
    model: bridge.config.model,
    hasKey: Boolean(bridge.config.apiKey),
    skipProviders: gate.skipProviders,
    enableModels: gate.enableModels,
  })

  const sessionModels = new Map<string, string>()

  function rememberSessionModel(sessionID: string, model: any) {
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

  function sessionIdOf(messages: any[]): string | undefined {
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

  return {
    "chat.params": async (input: any) => {
      try {
        rememberSessionModel(input?.sessionID, input?.model)
      } catch {}
    },

    tool: {
      vision: tool({
        description:
          'Inspect a local image with a vision model. Use when the text description of an image in the conversation is not enough to answer the user\'s question: pass the original image path and a specific question, and the vision model will look at the actual image and answer. The path must be one previously provided as "Original image:" in the conversation.',
        args: {
          path: tool.schema
            .string()
            .describe('The original image file path, as previously marked with "Original image:" in the conversation'),
          question: tool.schema
            .string()
            .describe(
              'A specific question about the image, e.g. "What is the error code on line 3?" or "What color is the button text?"',
            ),
        },
        async execute(args: { path?: string; question?: string }) {
          const resolved = resolve(String(args.path || ""))
          if (!resolved.startsWith(resolve(SANDBOX_DIR) + sep)) {
            return 'Error: path must be a sandbox path previously provided as "Original image:"'
          }
          const ext = resolved.slice(resolved.lastIndexOf(".") + 1).toLowerCase()
          const mime = EXT_TO_MIME[ext]
          if (!mime) return "Error: unsupported file type, images only"
          let buf: Buffer
          try {
            buf = await readFile(resolved)
          } catch {
            return "Error: original image not found or already pruned (sandbox keeps at most 100 images); ask the user to re-provide the image"
          }
          const dataUrl = `data:${mime};base64,${buf.toString("base64")}`
          const desc = await describeImage(
            dataUrl,
            DEFAULT_REQUERY_QUESTION(String(args.question || "")),
            bridge.config,
          )
          return desc ?? "Vision model temporarily unavailable, please try again later"
        },
      }),
    },

    "experimental.chat.messages.transform": async (_input: unknown, output: any) => {
      const messages = output?.messages
      if (!Array.isArray(messages)) return
      try {
        const sessionModelId = sessionModels.get(sessionIdOf(messages) ?? "")
        if (!gateAllows(gate, sessionModelId || extractActiveModel(messages).modelId)) return
        const targets = collectTargets(messages)
        if (targets.length === 0) return

        const sources: ImageSource[] = []
        const sandboxPaths: (string | null)[] = []
        for (const target of targets) {
          const resolved = await resolveImageUrl(target.part).catch(() => ({ url: undefined }))
          if (!resolved.url) {
            sources.push({ dataUrl: "", context: target.context })
            sandboxPaths.push(null)
            continue
          }
          const filePath = await saveImageToSandbox(resolved.url, target.part.mime, log)
          sources.push({ dataUrl: resolved.url, context: target.context })
          sandboxPaths.push(filePath)
        }

        const results = await bridge.describeAll(sources, (_s, i) => {
          const filePath = sandboxPaths[i]
          return filePath
            ? `(Original image: ${filePath} — if the description above misses details you need, call the vision tool: pass this path as "path" and your specific question as "question".)`
            : undefined
        })

        for (let i = 0; i < targets.length; i++) {
          const target = targets[i]
          const text = `${results[i]?.text ?? "[Image unavailable]"}${
            results[i]?.hint ? `\n${results[i].hint}` : ""
          }`
          if (target.kind === "part") {
            target.parts![target.index] = { type: "text", text }
          } else {
            const state = target.toolPart!.state
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
