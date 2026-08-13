/**
 * DeepSeek Harness adapter — a native Cordis plugin reusing the host-agnostic
 * core. DSH is the strongest host the bridge has: its `agent/pre-step`
 * waterfall can rewrite the claimed user-message batch before request
 * derivation (the OpenCode messages.transform equivalent), and its plugin
 * system is first-class.
 *
 * Install (both steps, all in `~/.dsh/cordis.patch.yml` — the machine-local
 * user layer; the running `dsh` process hot-reloads edits):
 *
 *   1. Mount the plugin:
 *        - insert:
 *            - id: vision-bridge
 *              name: /ABS/PATH/TO/vision-bridge/src/hooks/dsh.ts
 *
 *   2. Admit images at the gateway: DSH's session.prompt admission rejects
 *      image parts when the routed model does not declare image input, before
 *      any plugin can see them. Declare image input on the bridged models so
 *      the gateway admits them — the plugin then rewrites them to text before
 *      request derivation, so the provider never receives pixels:
 *        llm-pi-ai config → providers.<id>.models[]: add `input: [text, image]`
 *
 * Fast path: `agent/pre-step` replaces image content blocks (top-level and
 * nested inside tool-result blocks, e.g. screenshot attachments) with
 * vision-model descriptions. The original bytes stay in the durable
 * attachment store; the plugin remembers their refs for the re-query tool.
 *
 * Re-query: registers a model-facing `vision` tool that re-examines a
 * remembered original (by attachment_id) with a targeted question.
 *
 * This file deliberately imports nothing from the DSH SDK: it is loaded by
 * DSH's own TS loader inside the harness, and all host contracts used here
 * (ContentBlock / ToolDefinition / agent-pre-step) are structural.
 */
import {
  VisionBridge,
  buildConfig,
  buildModelGate,
  describeImage,
  gateAllows,
  openCodeAuthKey,
} from "../core.ts"
import { DEFAULT_REQUERY_QUESTION } from "../core.ts"

export const name = "vision-bridge"
/** Wait for the tool registry and the durable attachment store before loading. */
export const inject = ["tools", "attachments"]

/** Originals remembered per attachmentId for the re-query tool (process-local). */
const MAX_REMEMBERED = 200

type AttachmentRef = {
  attachmentId: string
  mediaType: string
  [key: string]: unknown
}

type ContentBlock = { type: string; [key: string]: unknown }
type UserMessage = { id: unknown; role: string; content: ContentBlock[]; source: unknown }

function modelIdOf(agent: any): string | undefined {
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  if (typeof provider === "string" && provider && typeof model === "string" && model) {
    return `${provider.toLowerCase()}/${model.toLowerCase()}`
  }
  if (typeof model === "string" && model) return model.toLowerCase()
  return undefined
}

/** First text block of the message, bounded — the vision model's context. */
function textContext(message: any): string {
  const content = message?.content
  if (!Array.isArray(content)) return ""
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") return block.text.slice(0, 500)
  }
  return ""
}

function imageRefOf(block: any): AttachmentRef | undefined {
  const ref = block?.attachment
  if (ref && typeof ref.attachmentId === "string" && ref.attachmentId) {
    return ref as AttachmentRef
  }
  return undefined
}

/** A located image block: its content path (for nested blocks) and durable ref. */
interface Hit {
  path: number[]
  ref: AttachmentRef
}

/**
 * Collect image blocks, recursing into tool-result blocks where tools keep
 * screenshot attachments. Paths are relative to the message's content array.
 */
function collectHits(blocks: any[], base: number[] = []): Hit[] {
  const hits: Hit[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const ref = imageRefOf(block)
    if (block?.type === "image" && ref) {
      hits.push({ path: [...base, i], ref })
      continue
    }
    if (block?.type === "tool-result" && Array.isArray(block.content)) {
      hits.push(...collectHits(block.content, [...base, i]))
    }
  }
  return hits
}

function blockAtPath(blocks: any[], path: number[]): any {
  let current = blocks
  let block: any = undefined
  for (const index of path) {
    block = current[index]
    current = block?.content
  }
  return block
}

/** Clone the content array, replacing hit paths (keyed `0,1,2`) with text blocks. */
function applyReplacements(
  blocks: any[],
  base: number[],
  replacements: Map<string, ContentBlock>,
): any[] {
  return blocks.map((block, i) => {
    const replacement = replacements.get([...base, i].join(","))
    if (replacement) return replacement
    if (block?.type === "tool-result" && Array.isArray(block.content)) {
      return { ...block, content: applyReplacements(block.content, [...base, i], replacements) }
    }
    return block
  })
}

/** Read attachment bytes and encode as a data: URL; "" on any failure (graceful placeholder). */
async function dataUrlOf(ctx: any, ref: AttachmentRef, signal?: AbortSignal): Promise<string> {
  try {
    const stored = await ctx.attachments.readImage(ref, signal)
    const mime = typeof ref.mediaType === "string" && ref.mediaType ? ref.mediaType : "image/png"
    return `data:${mime};base64,${Buffer.from(stored.data).toString("base64")}`
  } catch {
    return ""
  }
}

export function apply(ctx: any) {
  const env = process.env as Record<string, string | undefined>
  const bridge = new VisionBridge(buildConfig(env, openCodeAuthKey))
  const gate = buildModelGate(env)

  const log = (level: "info" | "warn", message: string, extra?: unknown) => {
    try {
      const logger = ctx?.logger
      if (typeof logger?.[level] === "function") logger[level](`[vision-bridge] ${message}`, extra)
    } catch {
      /* logging must never break the pipeline */
    }
  }
  if (bridge.config.debug) {
    log("info", "dsh adapter initialized", {
      model: bridge.config.model,
      baseUrl: bridge.config.baseUrl,
      hasKey: Boolean(bridge.config.apiKey),
      skipProviders: gate.skipProviders,
      enableModels: gate.enableModels,
    })
  }

  const seen = new Map<string, AttachmentRef>()
  function remember(ref: AttachmentRef): void {
    if (seen.has(ref.attachmentId)) return
    seen.set(ref.attachmentId, ref)
    if (seen.size > MAX_REMEMBERED) {
      const oldest = seen.keys().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
  }

  // ── fast path: rewrite image blocks before the request is derived ─────────
  ctx.on("agent/pre-step", async (payload: any, next: () => Promise<any>): Promise<any> => {
    const messages: UserMessage[] | undefined = payload?.messages
    if (!Array.isArray(messages) || messages.length === 0) return next()
    if (!gateAllows(gate, modelIdOf(payload?.agent))) return next()

    const hitsPerMessage = new Map<UserMessage, Hit[]>()
    for (const message of messages) {
      if (!Array.isArray(message?.content)) continue
      const hits = collectHits(message.content)
      if (hits.length > 0) hitsPerMessage.set(message, hits)
    }
    if (hitsPerMessage.size === 0) return next()

    try {
      const allHits: { hit: Hit; context: string }[] = []
      for (const [message, hits] of hitsPerMessage) {
        const context = textContext(message)
        for (const hit of hits) allHits.push({ hit, context })
      }

      const sources = []
      for (const { hit, context } of allHits) {
        remember(hit.ref)
        const dataUrl = await dataUrlOf(ctx, hit.ref, payload?.signal)
        sources.push({ dataUrl, context })
      }

      const results = await bridge.describeAll(sources, (_source, i) => {
        return `(Original image: ${allHits[i].hit.ref.attachmentId} — if the description above misses details you need, call the vision tool with this attachment_id and your specific question.)`
      })

      // Rewrite: clone each affected message, image blocks replaced by text.
      const rewritten = new Map<UserMessage, UserMessage>()
      let offset = 0
      for (const [message, hits] of hitsPerMessage) {
        const replacements = new Map<string, ContentBlock>()
        hits.forEach((hit, i) => {
          const result = results[offset + i]
          const text = `${result?.text ?? "[Image unavailable]"}${
            result?.hint ? `\n${result.hint}` : ""
          }`
          replacements.set(hit.path.join(","), { type: "text", text })
        })
        offset += hits.length
        rewritten.set(message, {
          ...message,
          content: applyReplacements(message.content, [], replacements),
        })
      }

      // Delegate so later listeners may still reject/rewrite, then fold our
      // rewrite onto the downstream decision.
      const downstream = await next()
      if (downstream?.kind !== "enter") return downstream
      return {
        kind: "enter",
        messages: downstream.messages.map((message: any) => rewritten.get(message) ?? message),
      }
    } catch (error) {
      // Fail open: a bridge failure must never block the turn.
      log("warn", "pre-step rewrite failed, images left untouched", String(error))
      return next()
    }
  })

  // ── re-query path: targeted inspection of a remembered original ───────────
  ctx.tools.register({
    name: "vision",
    description:
      'Inspect an image the user provided with a vision model. Use when the text description of an image in the conversation is not enough to answer the user\'s question: pass the attachment_id previously shown as "Original image:" plus a specific question, and the vision model will look at the actual image and answer.',
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        attachment_id: {
          type: "string",
          description:
            'The attachment_id previously marked as "Original image:" in the conversation.',
        },
        question: {
          type: "string",
          description:
            'A specific question about the image, e.g. "What is the error code on line 3?" or "What color is the button text?"',
        },
      },
      required: ["attachment_id", "question"],
    },
    output: {
      schema: { type: "string" },
      render: (_args: unknown, value: unknown) => [{ type: "text", text: String(value) }],
    },
    timeoutMs: bridge.config.timeoutMs + 5000,
    isConcurrencySafe: () => true,
    async execute(args: any, exec: any): Promise<string> {
      const id = String(args?.attachment_id ?? "").trim()
      const question = String(args?.question ?? "").trim()
      if (!id) return "Error: attachment_id is required"
      const ref = seen.get(id)
      if (!ref) {
        return 'Error: unknown attachment_id — it must be one previously shown as "Original image:" in the conversation'
      }
      const dataUrl = await dataUrlOf(ctx, ref, exec?.signal)
      if (!dataUrl) return "Error: the original image is no longer available; ask the user to re-provide the image"
      const desc = await describeImage(dataUrl, DEFAULT_REQUERY_QUESTION(question), bridge.config)
      return desc ?? "Vision model temporarily unavailable, please try again later"
    },
  })
}
