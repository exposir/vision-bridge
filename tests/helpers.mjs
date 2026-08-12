/** Shared test helpers: mocked vision API + tiny host SDK shims. */

export let apiCalls = []
let mode = "ok"

export function setFetchMode(m) {
  mode = m
}

export function getFetchMode() {
  return mode
}

export function resetMocks() {
  apiCalls = []
  mode = "ok"
}

export function mockFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    apiCalls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null })
    if (mode === "fail500") return new Response("server error", { status: 500 })
    return new Response(
      JSON.stringify({ choices: [{ message: { content: `MOCK-DESC#${apiCalls.length}` } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
}

export const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
export const PNG2 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
export const IMG = `data:image/png;base64,${PNG}`
