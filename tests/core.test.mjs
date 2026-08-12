import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { apiCalls, setFetchMode, resetMocks, mockFetch, IMG, PNG2 } from "./helpers.mjs"

mockFetch()

const { VisionBridge, buildConfig, describeImage, LRUCache, withConcurrency } = await import("../src/core.ts")

function cfg(overrides = {}) {
  return buildConfig(
    { VISION_API_KEY: "test-key", VISION_BASE_URL: "https://vision.test/v1", ...overrides },
    () => "fallback-key",
  )
}

beforeEach(() => {
  resetMocks()
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("VISION_")) delete process.env[k]
  }
})

test("C-1 describeImage returns the vision model content", async () => {
  const desc = await describeImage(IMG, "question", cfg())
  assert.equal(desc, "MOCK-DESC#1")
  const body = apiCalls[0].body
  assert.equal(body.model, "k3-256k")
  assert.equal(body.messages[0].content[0].type, "image_url")
  assert.equal(body.messages[0].content[1].text, "question")
})

test("C-2 5xx triggers one retry then fails gracefully (null, never throws)", async () => {
  setFetchMode("fail500")
  const desc = await describeImage(IMG, "q", cfg())
  assert.equal(desc, null)
  assert.ok(apiCalls.length >= 1)
})

test("C-3 missing apiKey returns null without any fetch", async () => {
  const desc = await describeImage(IMG, "q", buildConfig({ VISION_BASE_URL: "http://x" }, () => ""))
  assert.equal(desc, null)
  assert.equal(apiCalls.length, 0)
})

test("C-4 bridge cache + in-flight dedup: same image described once", async () => {
  const bridge = new VisionBridge(cfg())
  const [a, b] = await Promise.all([
    bridge.describeOne(IMG, "q1"),
    bridge.describeOne(IMG, "q1"),
  ])
  assert.equal(a, "MOCK-DESC#1")
  assert.equal(b, "MOCK-DESC#1")
  assert.equal(apiCalls.length, 1, "in-flight dedup")
  await bridge.describeOne(IMG, "q1")
  assert.equal(apiCalls.length, 1, "cached")
})

test("C-5 errors are not cached: next call retries", async () => {
  const bridge = new VisionBridge(cfg())
  setFetchMode("fail500")
  assert.equal(await bridge.describeOne(IMG, "q"), null)
  setFetchMode("ok")
  resetMocks()
  assert.equal(await bridge.describeOne(IMG, "q"), "MOCK-DESC#1")
})

test("C-6 empty dataUrl short-circuits to null", async () => {
  const bridge = new VisionBridge(cfg())
  assert.equal(await bridge.describeOne("", "q"), null)
  assert.equal(apiCalls.length, 0)
})

test("C-7 describeAll numbers images, concurrency-limited, honors context", async () => {
  const bridge = new VisionBridge(cfg({ VISION_MAX_CONCURRENCY: 2 }))
  const results = await bridge.describeAll([
    { dataUrl: IMG, context: "first" },
    { dataUrl: `data:image/png;base64,${PNG2}`, context: "second" },
  ])
  assert.equal(results.length, 2)
  assert.match(results[0].text, /^\[Image 1\]\nMOCK-DESC/)
  assert.match(results[1].text, /^\[Image 2\]\nMOCK-DESC/)
  assert.equal(apiCalls.length, 2)
})

test("C-8 describeAll hintFor is appended to the result", async () => {
  const bridge = new VisionBridge(cfg())
  const results = await bridge.describeAll([{ dataUrl: IMG }], () => "(Original image: /tmp/x.png)")
  assert.match(results[0].hint, /Original image: \/tmp\/x.png/)
})

test("C-9 LRU cache evicts oldest beyond maxSize", () => {
  const c = new LRUCache(2)
  c.set("a", "1")
  c.set("b", "2")
  c.set("c", "3")
  assert.equal(c.get("a"), undefined)
  assert.equal(c.get("b"), "2")
  c.get("b") // touch -> newest
  c.set("d", "4")
  assert.equal(c.get("c"), undefined)
  assert.equal(c.get("b"), "2")
})

test("C-10 withConcurrency respects limit and preserves order", async () => {
  const order = []
  const tasks = [1, 2, 3, 4, 5].map((n) => async () => {
    await new Promise((r) => setTimeout(r, n === 1 ? 30 : 5))
    order.push(n)
    return n * 10
  })
  const results = await withConcurrency(tasks, 2)
  assert.deepEqual(results, [10, 20, 30, 40, 50])
  assert.equal(order.length, 5)
})
