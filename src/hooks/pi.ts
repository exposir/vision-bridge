/**
 * pi adapter — wires the vision-bridge core into pi's `input` event
 * (fast path) plus a `view_image` re-query tool.
 *
 * Install (pi): copy this file plus src/core.ts into
 * ~/.pi/agent/extensions/vision-bridge/ (add package.json with
 * @sinclair/typebox dependency) and /reload in pi.
 *
 * Beyond pasted attachments, this adapter also detects image file paths
 * inside the input text (e.g. pi clipboard files) and describes them.
 */
import { existsSync, readFileSync } from "node:fs"
import { VisionBridge, buildConfig, describeImage, openCodeAuthKey } from "../core.ts"
import { DEFAULT_REQUERY_QUESTION } from "../core.ts"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "@sinclair/typebox"

// Matches absolute image paths (incl. pi clipboard files), file:// URLs and data: URLs.
// Only used as a hint: every match must also pass existsSync() before it is processed.
const IMAGE_PATH_RE =
  /(?<![A-Za-z0-9])((?:file:\/\/[^\s"'`]+)|(?:data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)|(?:\/[^\s"'`]+\.(?:png|jpe?g|webp|gif|bmp)))/gi

function extractImagePaths(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(IMAGE_PATH_RE)) {
    let raw = m[1]
    if (raw.startsWith("file://")) raw = raw.slice("file://".length)
    if (raw.startsWith("data:")) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    if (existsSync(raw)) out.push(raw)
  }
  return out
}

export default function (pi: ExtensionAPI) {
  const env = process.env as Record<string, string | undefined>
  const bridge = new VisionBridge(buildConfig(env, openCodeAuthKey))

  // ── fast path: intercept images on user input ────────────────────────────
  pi.on("input", async (event) => {
    const attached = event.images ?? []
    const textPaths = extractImagePaths(event.text)

    if (attached.length === 0 && textPaths.length === 0) return { action: "continue" }

    const context = event.text.slice(0, 500)
    const sources: { dataUrl: string; context: string }[] = []

    for (const img of attached) {
      if (typeof img.data !== "string") continue
      sources.push({
        dataUrl: VisionBridge.dataUrlFromBase64(img.data, img.mimeType),
        context,
      })
    }
    for (const p of textPaths) {
      const dataUrl = VisionBridge.dataUrlFromFile(p)
      if (dataUrl) sources.push({ dataUrl, context })
    }
    if (sources.length === 0) return { action: "continue" }

    const results = await bridge.describeAll(sources)

    const blocks = results.map((r) => `${r.text}${r.hint ? `\n${r.hint}` : ""}`).join("\n\n")
    const hint = `\n\n(以上图片已由视觉模型转述。如需查看某张图片的更多细节，可调用 view_image 工具，传入图片路径和具体问题。)`
    const text = event.text.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, "[image]")

    return {
      action: "transform",
      text: `${text}\n\n${blocks}${hint}`,
      images: [], // drop image payloads — the chat model is text-only
    }
  })

  // ── re-query path: on-demand targeted inspection ─────────────────────────
  pi.registerTool({
    name: "view_image",
    label: "View Image",
    description:
      "Inspect a local image file with a vision model. Use when a text description in the conversation is not enough to answer the user's question: pass the image's absolute path and a specific question, and the vision model will look at the actual image and answer.",
    promptSnippet: "view_image(path, question): inspect a local image via a vision model",
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute path to the image file (png/jpg/jpeg/webp/gif/bmp)",
      }),
      question: Type.String({
        description:
          'A specific question about the image, e.g. "What is the error code on line 3?" or "What color is the button text?"',
      }),
    }),
    async execute(_toolCallId, params) {
      const p = String(params.path ?? "")
      if (!p || !existsSync(p)) {
        return {
          content: [{ type: "text", text: `Error: image file not found: ${p}` }],
          details: {},
        }
      }
      const dataUrl = VisionBridge.dataUrlFromFile(p)
      if (!dataUrl) {
        return {
          content: [{ type: "text", text: "Error: unsupported file type, images only" }],
          details: {},
        }
      }
      const desc = await describeImage(
        dataUrl,
        DEFAULT_REQUERY_QUESTION(String(params.question ?? "")),
        bridge.config,
      )
      return {
        content: [
          {
            type: "text",
            text: desc ?? "Vision model temporarily unavailable, please try again later",
          },
        ],
        details: {},
      }
    },
  })

  if (bridge.config.debug) {
    console.error(
      `[vision-bridge] pi adapter initialized: model=${bridge.config.model} baseUrl=${bridge.config.baseUrl} hasKey=${Boolean(bridge.config.apiKey)}`,
    )
  }
}
