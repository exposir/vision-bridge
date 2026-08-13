/**
 * vision-bridge — give text-only models (e.g. DeepSeek) image understanding
 * via a vision model, without switching models.
 *
 * Architecture: host-agnostic core (src/core.ts) + thin host adapters.
 *   - src/hooks/opencode.ts — OpenCode plugin (messages.transform + vision tool)
 *   - src/hooks/pi.ts       — pi extension (input event + view_image tool)
 *   - src/hooks/grok.ts     — Grok CLI re-query, DeepSeek-only (not a hook)
 *
 * Build a single-file OpenCode plugin with: npm run build
 * The pi adapter is used directly from source (pi loads TS natively).
 */
export { VisionBridge, buildConfig, describeImage, hashKey, openCodeAuthKey, withConcurrency, LRUCache, EXT_TO_MIME, DEFAULT_QUESTION, DEFAULT_REQUERY_QUESTION } from "./core.ts"
export type { BridgeConfig, ImageSource, DescribeResult, KeyProvider } from "./core.ts"
export { default as opencodePlugin } from "./hooks/opencode.ts"
export { default as piExtension } from "./hooks/pi.ts"
export {
  isDeepSeekFamily,
  shouldDescribeGrok,
  modelMatches,
  readConfigDefaultModel,
  readSessionModelId,
} from "./hooks/grok-gate.ts"
