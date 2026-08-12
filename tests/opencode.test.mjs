import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apiCalls, setFetchMode, resetMocks, mockFetch, IMG, PNG2, PNG } from "./helpers.mjs"

mockFetch()

const { default: Plugin } = await import("../src/hooks/opencode.ts")

const DEEPSEEK = { providerID: "deepseek", modelID: "deepseek-v4-flash" }
const KIMI = { providerID: "kimi-for-coding", modelID: "k3-256k" }

async function mk() {
  const plugin = await Plugin({ client: undefined })
  return {
    params: plugin["chat.params"],
    transform: plugin["experimental.chat.messages.transform"],
    vision: plugin.tool?.vision,
  }
}

const imgPart = (sid, url = IMG) => ({ type: "file", mime: "image/png", url, sessionID: sid })

beforeEach(() => {
  resetMocks()
  delete process.env.VISION_ENABLE_MODELS
  delete process.env.VISION_SKIP_PROVIDERS
})

test("REQ-1 uploaded image is auto-replaced with a description (default: all models)", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const out = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [
    { type: "text", text: "what is this", sessionID: "s1" },
    imgPart("s1"),
  ] }] }
  await transform({}, out)
  const p = out.messages[0].parts[1]
  assert.equal(p.type, "text")
  assert.match(p.text, /^\[Image 1\]\nMOCK-DESC/)
  assert.equal(apiCalls.length, 1)
})

test("REQ-2 tool screenshot: description appended to tool output, image attachment removed, non-image kept", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const toolPart = {
    type: "tool",
    state: {
      status: "completed",
      output: "screenshot taken",
      attachments: [imgPart("s1"), { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,JVBERi0=" }],
    },
  }
  const out = { messages: [{ info: { role: "assistant", sessionID: "s1", model: DEEPSEEK }, parts: [toolPart] }] }
  await transform({}, out)
  assert.match(toolPart.state.output, /screenshot taken\n\n\[Image 1\]\nMOCK-DESC/)
  assert.equal(toolPart.state.attachments.length, 1)
  assert.equal(toolPart.state.attachments[0].mime, "application/pdf")
  assert.equal(apiCalls.length, 1)
})

test("REQ-3a with VISION_ENABLE_MODELS whitelist: non-listed model (kimi) untouched", async () => {
  process.env.VISION_ENABLE_MODELS = "deepseek-v4-flash"
  const { params, transform } = await mk()
  await params({ sessionID: "s2", model: KIMI })
  const out = { messages: [{ info: { role: "user", sessionID: "s2" }, parts: [imgPart("s2")] }] }
  await transform({}, out)
  assert.equal(out.messages[0].parts[0].type, "file")
  assert.equal(apiCalls.length, 0)
})

test("REQ-3b whitelist bare modelID matches any provider (opencode-go / deepseek / any proxy)", async () => {
  process.env.VISION_ENABLE_MODELS = "deepseek-v4-flash"
  const { params, transform } = await mk()
  for (const providerID of ["opencode-go", "deepseek", "any-proxy"]) {
    const sid = `prov-${providerID}`
    await params({ sessionID: sid, model: { providerID, modelID: "deepseek-v4-flash" } })
    const out = { messages: [{ info: { role: "user", sessionID: sid }, parts: [imgPart(sid)] }] }
    await transform({}, out)
    assert.equal(out.messages[0].parts[0].type, "text", `${providerID} should be processed`)
  }
  assert.equal(apiCalls.length, 1, "same image across providers hits one cache entry")
})

test("REQ-3c whitelist: same provider different modelID untouched (deepseek-v4-pro)", async () => {
  process.env.VISION_ENABLE_MODELS = "deepseek-v4-flash"
  const { params, transform } = await mk()
  await params({ sessionID: "s2b", model: { providerID: "opencode-go", modelID: "deepseek-v4-pro" } })
  const out = { messages: [{ info: { role: "user", sessionID: "s2b" }, parts: [imgPart("s2b")] }] }
  await transform({}, out)
  assert.equal(out.messages[0].parts[0].type, "file")
  assert.equal(apiCalls.length, 0)
})

test("REQ-3d with VISION_SKIP_PROVIDERS blacklist: listed provider untouched, others processed", async () => {
  process.env.VISION_SKIP_PROVIDERS = "kimi-for-coding"
  const { params, transform } = await mk()
  await params({ sessionID: "s2c", model: KIMI })
  const out1 = { messages: [{ info: { role: "user", sessionID: "s2c" }, parts: [imgPart("s2c")] }] }
  await transform({}, out1)
  assert.equal(out1.messages[0].parts[0].type, "file", "kimi should be skipped")

  await params({ sessionID: "s2d", model: DEEPSEEK })
  const out2 = { messages: [{ info: { role: "user", sessionID: "s2d" }, parts: [imgPart("s2d")] }] }
  await transform({}, out2)
  assert.equal(out2.messages[0].parts[0].type, "text", "deepseek should be processed")
  assert.equal(apiCalls.length, 1)
})

test("REQ-3e default (no config): even vision-capable-adjacent models are processed", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s2e", model: KIMI })
  const out = { messages: [{ info: { role: "user", sessionID: "s2e" }, parts: [imgPart("s2e")] }] }
  await transform({}, out)
  assert.equal(out.messages[0].parts[0].type, "text")
  assert.equal(apiCalls.length, 1)
})

test("REQ-4 first-turn session (no assistant message) still identified via chat.params", async () => {
  process.env.VISION_ENABLE_MODELS = "deepseek-v4-flash"
  const { params, transform } = await mk()
  await params({ sessionID: "s3", model: DEEPSEEK })
  const out = { messages: [{ info: { role: "user", sessionID: "s3" }, parts: [imgPart("s3")] }] }
  await transform({}, out)
  assert.equal(out.messages[0].parts[0].type, "text")
  assert.equal(apiCalls.length, 1)
})

test("REQ-5 whitelist + unknown model: stays untouched (strict allowlist)", async () => {
  process.env.VISION_ENABLE_MODELS = "deepseek-v4-flash"
  const { transform } = await mk()
  const out = { messages: [{ info: { role: "user" }, parts: [imgPart(undefined)] }] }
  await transform({}, out)
  assert.equal(out.messages[0].parts[0].type, "file")
  assert.equal(apiCalls.length, 0)
})

test("REQ-6 replacement text carries sandbox path of the original image, file exists", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const out = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1")] }] }
  await transform({}, out)
  const text = out.messages[0].parts[0].text
  const m = text.match(/Original image: (\S+?) —/)
  assert.ok(m, "text should contain the original image path")
  const st = await stat(m[1])
  assert.ok(st.isFile() && st.size > 0, "sandbox file should exist")
})

test("REQ-7 vision tool: re-queries the original image with a specific question", async () => {
  const { params, transform, vision } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const out = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1")] }] }
  await transform({}, out)
  const path = out.messages[0].parts[0].text.match(/Original image: (\S+?) —/)[1]

  const before = apiCalls.length
  const result = await vision.execute({ path, question: "What is the error code on line 3?" }, {})
  assert.match(String(result), /MOCK-DESC/)
  assert.equal(apiCalls.length, before + 1)
  const lastReq = apiCalls.at(-1).body
  const promptText = lastReq.messages[0].content.find((c) => c.type === "text").text
  assert.match(promptText, /What is the error code on line 3\?/)
})

test("REQ-8 vision tool: rejects paths outside the sandbox", async () => {
  const { vision } = await mk()
  const r1 = await vision.execute({ path: "/etc/passwd", question: "x" }, {})
  assert.match(String(r1), /Error/)
  const r2 = await vision.execute({ path: join(tmpdir(), "evil.png"), question: "x" }, {})
  assert.match(String(r2), /Error/)
})

test("REQ-9 vision tool: pruned/missing image returns a clear error", async () => {
  const { vision } = await mk()
  const r = await vision.execute({ path: join(tmpdir(), "opencode-vision-bridge", "not-exist.png"), question: "x" }, {})
  assert.match(String(r), /not found|pruned/)
})

test("Q-1 same image in multiple places: in-flight dedup + cross-turn cache", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const out = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1"), imgPart("s1")] }] }
  await transform({}, out)
  assert.equal(apiCalls.length, 1, "concurrent duplicates share one API call")

  const out2 = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1")] }] }
  await transform({}, out2)
  assert.equal(apiCalls.length, 1, "second transform fully served from cache")
})

test("Q-2 API failure: graceful placeholder, error not cached, next turn retries", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  setFetchMode("fail500")
  const out1 = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1")] }] }
  await transform({}, out1)
  assert.match(out1.messages[0].parts[0].text, /description unavailable/)
  assert.ok(apiCalls.length >= 1)

  setFetchMode("ok")
  const callsBefore = apiCalls.length
  const out2 = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1")] }] }
  await transform({}, out2)
  assert.match(out2.messages[0].parts[0].text, /MOCK-DESC/, "error was not cached; retry succeeded")
  assert.ok(apiCalls.length > callsBefore)
})

test("Q-3 file:// local image is also handled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vb-test-"))
  const filePath = join(dir, "shot.png")
  await writeFile(filePath, Buffer.from(PNG, "base64"))
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const out = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1", `file://${filePath}`)] }] }
  await transform({}, out)
  const p = out.messages[0].parts[0]
  assert.equal(p.type, "text")
  assert.match(p.text, /MOCK-DESC/)
  assert.match(p.text, /Original image:/)
})

test("Q-4 multiple images: numbered and replaced individually", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const out = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [
    imgPart("s1"),
    imgPart("s1", `data:image/png;base64,${PNG2}`),
  ] }] }
  await transform({}, out)
  assert.match(out.messages[0].parts[0].text, /^\[Image 1\]/)
  assert.match(out.messages[0].parts[1].text, /^\[Image 2\]/)
  assert.equal(apiCalls.length, 2)
})
