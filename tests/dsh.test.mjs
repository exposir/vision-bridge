import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { apiCalls, resetMocks, mockFetch, PNG, PNG2 } from "./helpers.mjs"

mockFetch()

const { apply, name, inject } = await import("../src/hooks/dsh.ts")

/** Minimal DSH harness mock: event bus, attachment store, tool registry. */
function mkCtx() {
  const handlers = {}
  const tools = []
  const images = new Map()
  const ctx = {
    on: (ev, h) => {
      handlers[ev] = h
    },
    logger: { info() {}, warn() {} },
    attachments: {
      readImage: async (ref) => {
        const hit = images.get(String(ref.attachmentId))
        if (!hit) throw new Error("attachment not found")
        return { ref, data: hit }
      },
    },
    tools: { register: (def) => tools.push(def) },
  }
  const addImage = (attachmentId, base64) =>
    images.set(attachmentId, Buffer.from(base64, "base64"))
  const imgBlock = (attachmentId) => ({
    type: "image",
    attachment: { attachmentId, mediaType: "image/png", bytes: 1, width: 1, height: 1 },
  })
  const userMessage = (content) => ({ id: `m${Math.random()}`, role: "user", content, source: { kind: "user" } })
  return { ctx, handlers, tools, addImage, imgBlock, userMessage }
}

function agentOf(provider = "opencode-go", model = "deepseek-v4-pro") {
  return { options: { provider, model } }
}

function payloadOf(messages, agent = agentOf()) {
  return { agent, messages, turn: 1, step: 1, signal: undefined }
}

beforeEach(() => {
  resetMocks()
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("VISION_")) delete process.env[k]
  }
})

test("D-1 fast path: image block is replaced with a description before request derivation", async () => {
  const { ctx, handlers, addImage, imgBlock, userMessage } = mkCtx()
  addImage("att-1", PNG)
  apply(ctx)
  assert.equal(name, "vision-bridge")
  assert.deepEqual(inject, ["tools", "attachments"])

  const messages = [userMessage([{ type: "text", text: "what is this" }, imgBlock("att-1")])]
  let delegated = false
  const next = async () => {
    delegated = true
    return { kind: "enter", messages }
  }
  const decision = await handlers["agent/pre-step"](payloadOf(messages), next)

  assert.equal(delegated, true, "downstream listeners must run")
  assert.equal(decision.kind, "enter")
  const blocks = decision.messages[0].content
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, "text")
  assert.equal(blocks[1].type, "text")
  assert.match(blocks[1].text, /^\[Image 1\]\nMOCK-DESC#1/)
  assert.match(blocks[1].text, /Original image: att-1/)
  assert.equal(apiCalls.length, 1)
  const prompt = apiCalls[0].body.messages[0].content.find((c) => c.type === "text").text
  assert.match(prompt, /what is this/, "user text rides along as context")
})

test("D-2 pass-through: no images, empty batch, and gated-out models all delegate untouched", async () => {
  const { ctx, handlers, addImage, imgBlock, userMessage } = mkCtx()
  addImage("att-1", PNG)
  process.env.VISION_ENABLE_MODELS = "deepseek-v4-flash"
  apply(ctx)
  const pre = handlers["agent/pre-step"]
  const delegated = { kind: "enter", messages: [] }
  const next = async () => delegated

  // No images.
  const plain = [userMessage([{ type: "text", text: "hello" }])]
  assert.equal(await pre(payloadOf(plain), next), delegated)
  // Empty batch.
  assert.equal(await pre(payloadOf([]), next), delegated)
  // Allowlisted gate: non-listed model passes through.
  assert.equal(await pre(payloadOf([userMessage([imgBlock("att-1")])]), next), delegated)
  assert.equal(apiCalls.length, 0, "gated-out model never bills the vision API")
})

test("D-3 allowlist gate: listed model is processed", async () => {
  const { ctx, handlers, addImage, imgBlock, userMessage } = mkCtx()
  addImage("att-1", PNG)
  process.env.VISION_ENABLE_MODELS = "deepseek-v4-flash"
  apply(ctx)

  const messages = [userMessage([imgBlock("att-1")])]
  const next = async () => ({ kind: "enter", messages })
  const decision = await handlers["agent/pre-step"](
    payloadOf(messages, agentOf("opencode-go", "deepseek-v4-flash")),
    next,
  )
  assert.equal(decision.messages[0].content[0].type, "text")
  assert.equal(apiCalls.length, 1)
})

test("D-4 provider blacklist gate: listed provider passes through, others processed", async () => {
  const { ctx, handlers, addImage, imgBlock, userMessage } = mkCtx()
  addImage("att-1", PNG)
  process.env.VISION_SKIP_PROVIDERS = "grok"
  apply(ctx)

  const delegated = { kind: "enter", messages: [] }
  const next = async () => delegated
  assert.equal(await handlers["agent/pre-step"](payloadOf([userMessage([imgBlock("att-1")])], agentOf("grok", "grok-4.6")), next), delegated)
  assert.equal(apiCalls.length, 0)
})

test("D-5 multiple images: numbered labels, duplicates deduped, one text block each", async () => {
  const { ctx, handlers, addImage, imgBlock, userMessage } = mkCtx()
  addImage("att-a", PNG)
  addImage("att-b", PNG2)
  apply(ctx)

  const messages = [userMessage([imgBlock("att-a"), imgBlock("att-b"), imgBlock("att-a")])]
  const next = async () => ({ kind: "enter", messages })
  const decision = await handlers["agent/pre-step"](payloadOf(messages), next)
  const blocks = decision.messages[0].content
  assert.match(blocks[0].text, /^\[Image 1\]/)
  assert.match(blocks[1].text, /^\[Image 2\]/)
  assert.match(blocks[2].text, /^\[Image 3\]/)
  assert.equal(apiCalls.length, 2, "the duplicated image costs one vision call")
})

test("D-6 downstream decision is preserved and its extra messages survive the rewrite", async () => {
  const { ctx, handlers, addImage, imgBlock, userMessage } = mkCtx()
  addImage("att-1", PNG)
  apply(ctx)

  const messages = [userMessage([imgBlock("att-1")])]
  const extra = userMessage([{ type: "text", text: "injected by another listener" }])
  const decision = await handlers["agent/pre-step"](payloadOf(messages), async () => ({
    kind: "enter",
    messages: [...messages, extra],
  }))
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].content[0].type, "text")
  assert.equal(decision.messages[1].content[0].text, "injected by another listener")

  // A downstream reject must pass through unchanged.
  const rejected = await handlers["agent/pre-step"](payloadOf(messages), async () => ({ kind: "reject" }))
  assert.equal(rejected.kind, "reject")
})

test("D-7 vision outage degrades gracefully: placeholder replaces the image, turn is never blocked", async () => {
  const { ctx, handlers, addImage, imgBlock, userMessage } = mkCtx()
  addImage("att-1", PNG)
  apply(ctx)
  // Break the attachment store: readImage throws.
  ctx.attachments.readImage = async () => {
    throw new Error("boom")
  }
  const messages = [userMessage([imgBlock("att-1")])]
  const decision = await handlers["agent/pre-step"](payloadOf(messages), async () => ({
    kind: "enter",
    messages,
  }))
  assert.equal(decision.kind, "enter")
  assert.equal(decision.messages[0].content[0].type, "text")
  assert.match(decision.messages[0].content[0].text, /description unavailable/)
  assert.equal(apiCalls.length, 0, "unreadable images never bill the vision API")
})

test("D-8 vision re-query tool: known id re-examines the original with the question", async () => {
  const { ctx, handlers, tools, addImage, imgBlock, userMessage } = mkCtx()
  addImage("att-1", PNG)
  apply(ctx)

  // Populate the registry via one fast-path transform.
  const messages = [userMessage([imgBlock("att-1")])]
  await handlers["agent/pre-step"](payloadOf(messages), async () => ({ kind: "enter", messages }))

  const vision = tools.find((t) => t.name === "vision")
  assert.ok(vision, "vision tool registered")
  const before = apiCalls.length
  const answer = await vision.execute(
    { attachment_id: "att-1", question: "What is the error code on line 3?" },
    { signal: undefined },
  )
  assert.match(answer, /MOCK-DESC/)
  assert.equal(apiCalls.length, before + 1)
  const prompt = apiCalls.at(-1).body.messages[0].content.find((c) => c.type === "text").text
  assert.match(prompt, /What is the error code on line 3\?/)
})

test("D-9 vision re-query tool: unknown id and lost originals produce clear errors", async () => {
  const { ctx, handlers, tools, addImage, imgBlock, userMessage } = mkCtx()
  addImage("att-1", PNG)
  apply(ctx)
  const messages = [userMessage([imgBlock("att-1")])]
  await handlers["agent/pre-step"](payloadOf(messages), async () => ({ kind: "enter", messages }))
  const vision = tools.find((t) => t.name === "vision")

  assert.match(await vision.execute({ attachment_id: "nope", question: "q" }, {}), /unknown attachment_id/)
  assert.match(await vision.execute({ attachment_id: "", question: "q" }, {}), /required/)
  // Originals can disappear after a restart; the tool must say so, not crash.
  ctx.attachments.readImage = async () => {
    throw new Error("gone")
  }
  assert.match(await vision.execute({ attachment_id: "att-1", question: "q" }, {}), /no longer available/)
})

test("D-10 vision API failure inside the tool returns a graceful retry message", async () => {
  const { ctx, handlers, tools, addImage, imgBlock, userMessage } = mkCtx()
  addImage("att-1", PNG)
  apply(ctx)
  const messages = [userMessage([imgBlock("att-1")])]
  await handlers["agent/pre-step"](payloadOf(messages), async () => ({ kind: "enter", messages }))
  const vision = tools.find((t) => t.name === "vision")
  const { setFetchMode } = await import("./helpers.mjs")
  setFetchMode("fail500")
  assert.match(await vision.execute({ attachment_id: "att-1", question: "q" }, {}), /temporarily unavailable/)
})

test("D-11 images nested inside tool-result blocks (screenshots) are described in place", async () => {
  const { ctx, handlers, addImage, imgBlock, userMessage } = mkCtx()
  addImage("att-nested", PNG)
  apply(ctx)

  const toolResult = {
    type: "tool-result",
    toolCallId: "call-1",
    content: [
      { type: "text", text: "screenshot taken" },
      imgBlock("att-nested"),
    ],
  }
  const messages = [userMessage([{ type: "text", text: "check this" }, toolResult])]
  const decision = await handlers["agent/pre-step"](payloadOf(messages), async () => ({
    kind: "enter",
    messages,
  }))

  const blocks = decision.messages[0].content
  assert.equal(blocks[0].type, "text", "unrelated text block untouched")
  assert.equal(blocks[1].type, "tool-result", "tool-result envelope preserved")
  const inner = blocks[1].content
  assert.equal(inner.length, 2)
  assert.equal(inner[0].type, "text")
  assert.equal(inner[1].type, "text", "nested image replaced by description")
  assert.match(inner[1].text, /^\[Image 1\]\nMOCK-DESC#1/)
  assert.match(inner[1].text, /Original image: att-nested/)
  assert.equal(apiCalls.length, 1)
})

test("D-12 plugin config gate: allowlist only bridges the listed models", async () => {
  const { ctx, handlers, addImage, imgBlock, userMessage } = mkCtx()
  addImage("att-1", PNG)
  apply(ctx, { allowlist: ["deepseek-v4-flash"] })

  const pre = handlers["agent/pre-step"]
  const delegated = { kind: "enter", messages: [] }
  const next = async () => delegated
  const img = () => payloadOf([userMessage([imgBlock("att-1")])])

  // Non-listed model (even another DeepSeek) passes through untouched.
  assert.equal(await pre(img(), next), delegated)
  // Listed model is processed regardless of provider.
  const messages = [userMessage([imgBlock("att-1")])]
  const decision = await pre(payloadOf(messages, agentOf("opencode-go", "deepseek-v4-flash")), async () => ({
    kind: "enter",
    messages,
  }))
  assert.equal(decision.messages[0].content[0].type, "text")
  assert.equal(apiCalls.length, 1)
})

test("D-13 plugin config gate: skipProviders blacklist; env vars win over config", async () => {
  const { ctx, handlers, addImage, imgBlock, userMessage } = mkCtx()
  addImage("att-1", PNG)
  // config says skip kimi-code, but the env allowlist is authoritative.
  process.env.VISION_ENABLE_MODELS = "deepseek-v4-pro"
  apply(ctx, { skipProviders: ["kimi-code"] })

  const delegated = { kind: "enter", messages: [] }
  const next = async () => delegated
  assert.equal(
    await handlers["agent/pre-step"](payloadOf([userMessage([imgBlock("att-1")])], agentOf("kimi-code", "k3-256k")), next),
    delegated,
    "env allowlist excludes kimi",
  )
  const messages = [userMessage([imgBlock("att-1")])]
  const decision = await handlers["agent/pre-step"](payloadOf(messages), async () => ({
    kind: "enter",
    messages,
  }))
  assert.equal(decision.messages[0].content[0].type, "text", "env allowlist admits deepseek-v4-pro")
  assert.equal(apiCalls.length, 1)
})

test("D-14 Config validator: Standard Schema contract, unknown keys and bad shapes fail loud", async () => {
  const { Config } = await import("../src/hooks/dsh.ts")
  const v = Config["~standard"].validate
  assert.deepEqual(v({ allowlist: ["deepseek-v4-flash"], skipProviders: ["grok"] }).value, {
    allowlist: ["deepseek-v4-flash"],
    skipProviders: ["grok"],
  })
  assert.deepEqual(v(undefined).value, {})
  assert.ok(v({ allowlist: [42] }).issues.length > 0)
  assert.ok(v({ nope: true }).issues.length > 0)
  assert.ok(v("not-an-object").issues.length > 0)
})
