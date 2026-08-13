import { test } from "node:test"
import assert from "node:assert/strict"
import {
  isDeepSeekFamily,
  shouldDescribeGrok,
  modelMatches,
  readConfigDefaultModel,
  readSessionModelId,
} from "../src/hooks/grok-gate.ts"

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
