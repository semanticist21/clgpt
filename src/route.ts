import type { UpstreamModel } from "./token"

export type Dialect = "native" | "chat" | "responses"

/** Evidence of an unsupported route/model, not merely a bad request. */
export function nativeModelRejected(status: number, body: string): boolean {
  if (status === 404) return true
  if (![400, 415, 422].includes(status)) return false
  let message = body.trim()
  let code: unknown
  try {
    const parsed = JSON.parse(body)
    message = String(parsed?.error?.message ?? parsed?.message ?? "").trim()
    code = parsed?.error?.code ?? parsed?.code
  } catch {
    // ChatGPT may return a plain-text rejection.
  }
  if (typeof code === "string" && /^(?:model|endpoint)_(?:not_supported|unsupported|not_found)$/.test(code)) return true
  // Anchor on the rejected subject. "model X: unsupported parameter" must
  // not accidentally become a process-lifetime model demotion.
  if (/\b(?:parameter|argument|temperature|thinking|schema|moderation|content[_ -]filter)\b/i.test(message)) return false
  return /^(?:the\s+)?(?:requested\s+)?(?:model|endpoint)(?:\s+(?:["'][^"']+["']|[^\s:]+))?\s+(?:is\s+)?(?:not supported|unsupported|not found|not accessible via)(?:\b|$)/i.test(message) ||
    /^(?:unsupported|unknown)\s+(?:model|endpoint)(?:\s|:|$)/i.test(message)
}

/** Learned routes live for the adapter process. Callers pass the already
 * normalized upstream slug; normalizing twice can strip a real dated id. */
export class DialectRouter {
  private nativeRejectedModels = new Set<string>()
  private responsesOnlyModels = new Set<string>()

  select(model: string, info: UpstreamModel | undefined, nativeAvailable: boolean): Dialect {
    if (nativeAvailable && info?.endpoints.includes("/v1/messages") && !this.nativeRejectedModels.has(model)) return "native"
    return this.translated(model, info)
  }

  translated(model: string, info: UpstreamModel | undefined): "chat" | "responses" {
    if (this.responsesOnlyModels.has(model) ||
      (info?.endpoints.includes("/responses") && !info.endpoints.includes("/chat/completions"))) return "responses"
    return "chat"
  }

  rejectNative(model: string, status: number, body: string): boolean {
    if (!nativeModelRejected(status, body) || this.nativeRejectedModels.has(model)) return false
    this.nativeRejectedModels.add(model)
    return true
  }

  requireResponses(model: string): void {
    this.responsesOnlyModels.add(model)
  }
}
