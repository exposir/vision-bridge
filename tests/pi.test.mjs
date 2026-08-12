import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apiCalls, setFetchMode, resetMocks, mockFetch, PNG, PNG2 } from "./helpers.mjs"

mockFetch()

const { default: PiExtension } = await import("../src/hooks/pi.ts")

/** Minimal pi ExtensionAPI shim capturing registrations. */
function mkPi() {
  const handlers = {}
  const tools = []
  const api = {
    on: (ev, h) => {
      handlers[ev] = h
    },
    registerTool: (def) => {
      tools.push(def)
    },
  }
  PiExtension(api)
  return { input: handlers.input, viewImage: tools.find((t) => t.name === "view_image"), tools }
}

beforeEach(() => {
  resetMocks()
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("VISION_")) delete process.env[k]
  }
})

test("P-1 input with attached image: transform returns description text and drops image payload", async () => {
  const { input } = mkPi()
  const result = await input(
    { text: "看看这张图", images: [{ type: "image", data: PNG, mimeType: "image/png" }], source: "interactive" },
    {},
  )
  assert.equal(result.action, "transform")
  assert.match(result.text, /\[Image 1\]\nMOCK-DESC/)
  assert.deepEqual(result.images, [], "image payload must be dropped for text-only models")
  assert.equal(apiCalls.length, 1)
})

test("P-2 image path inside the input text is detected and described", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vb-pi-"))
  const filePath = join(dir, "clip.png")
  await writeFile(filePath, Buffer.from(PNG, "base64"))

  const { input } = mkPi()
  const result = await input({ text: `请看 ${filePath}`, source: "interactive" }, {})
  assert.equal(result.action, "transform")
  assert.match(result.text, /\[Image 1\]\nMOCK-DESC/)
  assert.equal(apiCalls.length, 1)
})

test("P-3 no images anywhere: pass through untouched", async () => {
  const { input } = mkPi()
  const result = await input({ text: "hello", source: "interactive" }, {})
  assert.deepEqual(result, { action: "continue" })
  assert.equal(apiCalls.length, 0)
})

test("P-4 non-existent image path is ignored", async () => {
  const { input } = mkPi()
  const result = await input({ text: "/tmp/does-not-exist-xyz.png", source: "interactive" }, {})
  assert.deepEqual(result, { action: "continue" })
  assert.equal(apiCalls.length, 0)
})

test("P-5 multiple images: numbered, described concurrently, duplicates deduped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vb-pi-"))
  const f1 = join(dir, "a.png")
  const f2 = join(dir, "b.png")
  await writeFile(f1, Buffer.from(PNG, "base64"))
  await writeFile(f2, Buffer.from(PNG2, "base64"))

  const { input } = mkPi()
  const result = await input(
    {
      text: `两张图 ${f1} ${f2}`,
      images: [{ type: "image", data: PNG2, mimeType: "image/png" }], // same content as f2
      source: "interactive",
    },
    {},
  )
  assert.equal(result.action, "transform")
  assert.match(result.text, /\[Image 1\]/)
  assert.match(result.text, /\[Image 2\]/)
  assert.match(result.text, /\[Image 3\]/)
  assert.equal(apiCalls.length, 2, "PNG2 appears twice but is described once")
})

test("P-6 view_image tool: re-queries any local image with a targeted question", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vb-pi-"))
  const filePath = join(dir, "shot.png")
  await writeFile(filePath, Buffer.from(PNG, "base64"))

  const { viewImage } = mkPi()
  const result = await viewImage.execute("call-1", { path: filePath, question: "What error code?" }, new AbortController().signal, () => {}, {})
  assert.match(result.content[0].text, /MOCK-DESC/)
  const promptText = apiCalls.at(-1).body.messages[0].content.find((c) => c.type === "text").text
  assert.match(promptText, /What error code\?/)
})

test("P-7 view_image tool: missing path and unsupported type produce errors", async () => {
  const { viewImage } = mkPi()
  const r1 = await viewImage.execute("c", { path: "/nope/nope.png", question: "q" }, undefined, undefined, {})
  assert.match(r1.content[0].text, /not found/)
  const r2 = await viewImage.execute("c", { path: "/etc/hosts", question: "q" }, undefined, undefined, {})
  assert.match(r2.content[0].text, /unsupported/)
})

test("P-8 failure: transform still succeeds with graceful placeholder, no throw", async () => {
  setFetchMode("fail500")
  const { input } = mkPi()
  const result = await input(
    { text: "图", images: [{ type: "image", data: PNG, mimeType: "image/png" }], source: "interactive" },
    {},
  )
  assert.equal(result.action, "transform")
  assert.match(result.text, /description unavailable/)
})
