import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let apiCalls = []
let fetchMode = "ok"

globalThis.fetch = async (url, opts = {}) => {
  apiCalls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null })
  if (fetchMode === "fail500") return new Response("server error", { status: 500 })
  return new Response(
    JSON.stringify({ choices: [{ message: { content: `MOCK描述#${apiCalls.length}` } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

const { default: Plugin } = await import("./vision-bridge.js")

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const IMG = `data:image/png;base64,${PNG}`
const DEEPSEEK = { providerID: "deepseek", modelID: "deepseek-v4-flash" }

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
  apiCalls = []
  fetchMode = "ok"
})

test("REQ-1 上传图片自动替换为文字描述，无需手动操作", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const out = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [
    { type: "text", text: "这是什么", sessionID: "s1" },
    imgPart("s1"),
  ] }] }
  await transform({}, out)
  const p = out.messages[0].parts[1]
  assert.equal(p.type, "text")
  assert.match(p.text, /^\[图像 1\]\nMOCK描述/)
  assert.equal(apiCalls.length, 1)
})

test("REQ-2 截图附件：描述追加到工具输出，图片附件移除，非图片附件保留", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const toolPart = {
    type: "tool",
    state: {
      status: "completed",
      output: "截图完成",
      attachments: [imgPart("s1"), { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,JVBERi0=" }],
    },
  }
  const out = { messages: [{ info: { role: "assistant", sessionID: "s1", model: DEEPSEEK }, parts: [toolPart] }] }
  await transform({}, out)
  assert.match(toolPart.state.output, /截图完成\n\n\[图像 1\]\nMOCK描述/)
  assert.equal(toolPart.state.attachments.length, 1)
  assert.equal(toolPart.state.attachments[0].mime, "application/pdf")
  assert.equal(apiCalls.length, 1)
})

test("REQ-3 非 deepseek-v4-flash 模型（kimi）：图片原样保留，零 API 调用", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s2", model: { providerID: "kimi-for-coding", modelID: "k3-256k" } })
  const out = { messages: [{ info: { role: "user", sessionID: "s2" }, parts: [imgPart("s2")] }] }
  await transform({}, out)
  assert.equal(out.messages[0].parts[0].type, "file")
  assert.equal(apiCalls.length, 0)
})

test("REQ-3b 同一 modelID 任意 provider 都生效（OpenCode Go / 任意代理）", async () => {
  const { params, transform } = await mk()
  for (const providerID of ["opencode-go", "deepseek", "any-proxy"]) {
    const sid = `prov-${providerID}`
    await params({ sessionID: sid, model: { providerID, modelID: "deepseek-v4-flash" } })
    const out = { messages: [{ info: { role: "user", sessionID: sid }, parts: [imgPart(sid)] }] }
    await transform({}, out)
    assert.equal(out.messages[0].parts[0].type, "text", `${providerID} 应被处理`)
  }
  assert.equal(apiCalls.length, 1, "同图跨 provider 命中同一缓存")
})

test("REQ-3c 同 provider 不同 modelID 不生效（deepseek-v4-pro）", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s2b", model: { providerID: "opencode-go", modelID: "deepseek-v4-pro" } })
  const out = { messages: [{ info: { role: "user", sessionID: "s2b" }, parts: [imgPart("s2b")] }] }
  await transform({}, out)
  assert.equal(out.messages[0].parts[0].type, "file")
  assert.equal(apiCalls.length, 0)
})

test("REQ-4 第一轮 deepseek 会话（无 assistant 消息）也能识别", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s3", model: DEEPSEEK })
  const out = { messages: [{ info: { role: "user", sessionID: "s3" }, parts: [imgPart("s3")] }] }
  await transform({}, out)
  assert.equal(out.messages[0].parts[0].type, "text")
  assert.equal(apiCalls.length, 1)
})

test("REQ-5 模型完全未知：安全方向不动", async () => {
  const { transform } = await mk()
  const out = { messages: [{ info: { role: "user" }, parts: [imgPart(undefined)] }] }
  await transform({}, out)
  assert.equal(out.messages[0].parts[0].type, "file")
  assert.equal(apiCalls.length, 0)
})

test("REQ-6 替换文本带原图沙箱路径，且文件真实存在", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const out = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1")] }] }
  await transform({}, out)
  const text = out.messages[0].parts[0].text
  const m = text.match(/原图：(\S+?) —/)
  assert.ok(m, "文本中应包含原图路径")
  const st = await stat(m[1])
  assert.ok(st.isFile() && st.size > 0, "沙箱文件应存在")
})

test("REQ-7 vision 工具：带具体问题定向查看原图", async () => {
  const { params, transform, vision } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const out = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1")] }] }
  await transform({}, out)
  const path = out.messages[0].parts[0].text.match(/原图：(\S+?) —/)[1]

  const before = apiCalls.length
  const result = await vision.execute({ path, question: "第3行错误码是什么" }, {})
  assert.match(String(result), /MOCK描述/)
  assert.equal(apiCalls.length, before + 1)
  const lastReq = apiCalls.at(-1).body
  const promptText = lastReq.messages[0].content.find((c) => c.type === "text").text
  assert.match(promptText, /第3行错误码是什么/)
})

test("REQ-8 vision 工具：沙箱外路径被拒绝", async () => {
  const { vision } = await mk()
  const r1 = await vision.execute({ path: "/etc/passwd", question: "x" }, {})
  assert.match(String(r1), /错误/)
  const r2 = await vision.execute({ path: join(tmpdir(), "evil.png"), question: "x" }, {})
  assert.match(String(r2), /错误/)
})

test("REQ-9 vision 工具：已清理的图返回明确错误", async () => {
  const { vision } = await mk()
  const r = await vision.execute({ path: join(tmpdir(), "opencode-vision-bridge", "not-exist.png"), question: "x" }, {})
  assert.match(String(r), /不存在|已清理/)
})

test("Q-1 同一张图多处出现：并发去重 + 跨轮缓存", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const out = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1"), imgPart("s1")] }] }
  await transform({}, out)
  assert.equal(apiCalls.length, 1, "同图并发只调 1 次")

  const out2 = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1")] }] }
  await transform({}, out2)
  assert.equal(apiCalls.length, 1, "二次 transform 全缓存命中")
})

test("Q-2 API 失败：降级占位、不缓存错误、下轮自动重试成功", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  fetchMode = "fail500"
  const out1 = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1")] }] }
  await transform({}, out1)
  assert.match(out1.messages[0].parts[0].text, /描述不可用/)
  assert.ok(apiCalls.length >= 1)

  fetchMode = "ok"
  const callsBefore = apiCalls.length
  const out2 = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1")] }] }
  await transform({}, out2)
  assert.match(out2.messages[0].parts[0].text, /MOCK描述/, "错误未被缓存，恢复后重试成功")
  assert.ok(apiCalls.length > callsBefore)
})

test("Q-3 file:// 本地图片也能处理", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vb-test-"))
  const filePath = join(dir, "shot.png")
  await writeFile(filePath, Buffer.from(PNG, "base64"))
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const out = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [imgPart("s1", `file://${filePath}`)] }] }
  await transform({}, out)
  const p = out.messages[0].parts[0]
  assert.equal(p.type, "text")
  assert.match(p.text, /MOCK描述/)
  assert.match(p.text, /原图：/)
})

test("Q-4 多图场景：各自编号替换", async () => {
  const { params, transform } = await mk()
  await params({ sessionID: "s1", model: DEEPSEEK })
  const PNG2 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  const out = { messages: [{ info: { role: "user", sessionID: "s1" }, parts: [
    imgPart("s1"),
    imgPart("s1", `data:image/png;base64,${PNG2}`),
  ] }] }
  await transform({}, out)
  assert.match(out.messages[0].parts[0].text, /^\[图像 1\]/)
  assert.match(out.messages[0].parts[1].text, /^\[图像 2\]/)
  assert.equal(apiCalls.length, 2)
})
