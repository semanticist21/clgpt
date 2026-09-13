import { classifyContent } from "./blocks"
import type { AnthropicRequest } from "./wire"

export const ONE_MILLION_TOKENS = 1_000_000
// An unknown model must not inherit a larger budget than a common 128k model.
// Discovery can lower this fallback further; it is not a claimed model limit.
export const UNKNOWN_MODEL_WINDOW = 128_000
export const TOKEN_WARNING_RATIO = 0.98
const CHARS_PER_TOKEN = 3.5
const IMAGE_TOKENS = 1_600
const MESSAGE_TOKENS = 4

export function fallbackInputWindow(windows: Array<number | undefined>): number {
  return Math.min(UNKNOWN_MODEL_WINDOW, ...windows.filter(
    (n): n is number => n !== undefined && Number.isFinite(n) && n > 0,
  ))
}

/** Rough text estimate, not a tokenizer or proof a request exceeds a limit. */
export function estimateTokens(payload: AnthropicRequest): number {
  let chars = 0
  let images = 0
  const count = (content: unknown): void => {
    for (const view of classifyContent(content)) {
      switch (view.kind) {
        case "text":
        case "unsupported":
          chars += view.text.length
          break
        case "image":
          images++
          break
        case "tool_use":
          // Arguments are model-visible JSON; ids and wire envelopes are not.
          chars += view.block.name.length + JSON.stringify(view.block.input ?? {}).length
          break
        case "tool_result":
          count(view.block.content)
          break
        default: {
          const exhaustive: never = view
          throw new Error(`unhandled content: ${exhaustive}`)
        }
      }
    }
  }
  for (const message of payload.messages ?? []) count(message.content)
  count(payload.system)
  for (const tool of payload.tools ?? []) {
    chars += tool.name.length + (tool.description?.length ?? 0)
    chars += JSON.stringify(tool.input_schema ?? {}).length
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS +
    (payload.messages?.length ?? 0) * MESSAGE_TOKENS
}
