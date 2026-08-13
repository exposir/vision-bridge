import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { apiCalls, resetMocks, mockFetch, PNG } from "./helpers.mjs"
import {
  isDeepSeekFamily,
  shouldDescribeGrok,
  modelMatches,
  readConfigDefaultModel,
  readSessionModelId,
} from "../src/hooks/grok-gate.ts"

mockFetch()

beforeEach(() => {
  resetMocks()
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("VISION_")) delete process.env[k]
  }
})

test("isDeepSeekFamily matches ids that contain deepseek", () => {
  assert.equal(isDeepSeekFamily("deepseek-v4-pro"), true)
  assert.equal(isDeepSeekFamily("deepseek-v4-flash"), true)
  assert.equal(isDeepSeekFamily("opencode-go/deepseek-v4-pro"), true)
  assert.equal(isDeepSeekFamily("grok-4.6"), false)
  assert.equal(isDeepSeekFamily("grok-build"), false)
  assert.equal(isDeepSeekFamily(undefined), false)
})

test("shouldDescribeGrok defaults to DeepSeek only", () => {
  assert.equal(shouldDescribeGrok("deepseek-v4-pro", {}), true)
  assert.equal(shouldDescribeGrok("grok-4.6", {}), false)
  assert.equal(shouldDescribeGrok(undefined, {}), false)
})

test("shouldDescribeGrok honors VISION_ENABLE_MODELS allowlist", () => {
  const env = { VISION_ENABLE_MODELS: "deepseek-v4-flash" }
  assert.equal(shouldDescribeGrok("deepseek-v4-flash", env), true)
  assert.equal(shouldDescribeGrok("deepseek-v4-pro", env), false)
  assert.equal(shouldDescribeGrok("grok-4.6", env), false)
})

test("modelMatches accepts bare id and provider/id", () => {
  assert.equal(modelMatches("deepseek-v4-pro", "deepseek-v4-pro"), true)
  assert.equal(modelMatches("deepseek-v4-pro", "opencode-go/deepseek-v4-pro"), true)
  assert.equal(modelMatches("opencode-go/deepseek-v4-pro", "opencode-go/deepseek-v4-pro"), true)
  assert.equal(modelMatches("opencode-go/deepseek-v4-pro", "deepseek-v4-pro"), false)
})

test("readConfigDefaultModel parses [models] default", () => {
  const toml = `[cli]\ninstaller = "internal"\n\n[models]\ndefault = "deepseek-v4-pro"\ndefault_reasoning_effort = "max"\n`
  assert.equal(readConfigDefaultModel(toml), "deepseek-v4-pro")
  assert.equal(readConfigDefaultModel("[ui]\nyolo = false\n"), undefined)
})

test("readSessionModelId reads current_model_id", () => {
  assert.equal(readSessionModelId('{"current_model_id":"deepseek-v4-flash"}'), "deepseek-v4-flash")
  assert.equal(readSessionModelId("{}"), undefined)
  assert.equal(readSessionModelId("not-json"), undefined)
})

test("G-CLI-1 disk cache is question-aware: re-query never returns the cached full description", async () => {
  // Isolate the on-disk cache: CACHE_DIR is derived from tmpdir() at module
  // load, so TMPDIR must be set before importing grok.ts.
  const dir = mkdtempSync(join(tmpdir(), "vb-grok-"))
  const prevTmp = process.env.TMPDIR
  process.env.TMPDIR = dir
  process.env.VISION_API_KEY = "test-key"
  process.env.VISION_GROK_MODEL = "deepseek-v4-pro"
  const { describePath } = await import("../src/hooks/grok.ts")
  const { buildConfig } = await import("../src/core.ts")

  const img = join(dir, "shot.png")
  writeFileSync(img, Buffer.from(PNG, "base64"))
  const cfg = buildConfig({ VISION_API_KEY: "test-key" }, () => "")

  try {
    // First CLI run: full description, cached on disk.
    const full = await describePath(img, cfg.question, cfg)
    assert.equal(full, "MOCK-DESC#1")

    // Second CLI run with a targeted question must reach the vision model,
    // not the disk cache (regression: cache key ignored the question).
    const targeted = await describePath(img, "targeted re-query question", cfg)
    assert.equal(targeted, "MOCK-DESC#2", "re-query must not be served the cached full description")
    assert.equal(apiCalls.length, 2, "two distinct vision calls")
    assert.match(apiCalls[1].body.messages[0].content[1].text, /targeted re-query question/)

    // Same question again still hits the disk cache (each CLI run is a fresh process).
    assert.equal(await describePath(img, "targeted re-query question", cfg), "MOCK-DESC#2")
    assert.equal(apiCalls.length, 2)
  } finally {
    if (prevTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = prevTmp
    rmSync(dir, { recursive: true, force: true })
  }
})
