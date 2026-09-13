// ChatGPT OAuth session caching and the allowlisted model catalog.

import { isMockMode, openaiBaseUrl, openaiFetch, openaiRequestHeaders } from "./api"
import { ensureOpenAIToken, type OpenAIIdentity } from "./auth"
import { advertisedId } from "./catalog"
import { isTlsTrustError } from "./tls"
import { setModelAliases } from "./translate"

export interface ModelMapping {
  opus: string
  sonnet: string
  haiku: string
  fable: string
}

export interface UpstreamModel {
  id: string
  name: string
  endpoints: string[]
  efforts: string[] | null
  maxPromptTokens?: number
  maxContextTokens?: number
  policyState?: string
  pickerEnabled?: boolean
  type?: string
  family?: string
}

let cached: OpenAIIdentity | null = null
let pending: Promise<OpenAIIdentity> | null = null

export async function getOpenAIIdentity(force = false): Promise<OpenAIIdentity> {
  if (!force && cached && cached.expires > Date.now() + 5 * 60 * 1000) return cached
  if (pending) return pending
  pending = ensureOpenAIToken(force).then((identity) => {
    cached = identity
    return identity
  }).finally(() => {
    pending = null
  })
  return pending
}

export async function getOpenAIToken(force = false): Promise<string> {
  return (await getOpenAIIdentity(force)).access
}

export function invalidateOpenAIToken(): void {
  cached = null
}

export async function openaiTokenFacts(): Promise<{ expiresAt?: number; accountId?: string }> {
  if (isMockMode()) return {}
  const identity = await getOpenAIIdentity()
  return { expiresAt: identity.expires, accountId: identity.accountId }
}

const DEFAULT_MODELS: UpstreamModel[] = [
  { id: "gpt-6-astra", name: "GPT-6 Astra", endpoints: ["/responses"], efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], maxPromptTokens: 272000, maxContextTokens: 872000, type: "chat", family: "gpt-6-astra" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", endpoints: ["/responses"], efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], maxPromptTokens: 272000, maxContextTokens: 872000, type: "chat", family: "gpt-5.6-sol" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", endpoints: ["/responses"], efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], maxPromptTokens: 272000, maxContextTokens: 872000, type: "chat", family: "gpt-5.6-terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", endpoints: ["/responses"], efforts: ["low", "medium", "high", "xhigh", "max"], maxPromptTokens: 200000, maxContextTokens: 400000, type: "chat", family: "gpt-5.6-luna" },
  { id: "gpt-5.5", name: "GPT-5.5", endpoints: ["/responses"], efforts: ["low", "medium", "high", "xhigh"], maxPromptTokens: 200000, maxContextTokens: 400000, type: "chat", family: "gpt-5.5" },
  { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", endpoints: ["/responses"], efforts: ["low", "medium", "high", "xhigh"], maxPromptTokens: 200000, maxContextTokens: 400000, type: "chat", family: "gpt-5.3-codex-spark" },
]

// Only GPT Responses models are accepted. This prevents arbitrary upstream
// ids from being injected into the Claude Code picker or OAuth request.
function allowedModel(id: string): boolean {
  return /^gpt-(?:5|6)(?:[.-]|$)/i.test(id) && !/(?:-pro|-preview|-chat)$/i.test(id)
}

function selectedCatalog(): UpstreamModel[] {
  const requested = process.env.CLGPT_MODELS?.split(",").map((id) => id.trim()).filter(Boolean)
  const source = requested?.length
    ? DEFAULT_MODELS.filter((model) => requested.includes(model.id))
    : DEFAULT_MODELS
  const filtered = source.filter((model) => allowedModel(model.id))
  if (requested?.length && filtered.length === 0) {
    throw new Error("CLGPT_MODELS contains no known allowlisted GPT model")
  }
  return filtered
}

let cachedModelList: UpstreamModel[] | null = null

export function upstreamModels(): UpstreamModel[] {
  return cachedModelList ?? []
}

export function modelInfo(id: string): UpstreamModel | undefined {
  return cachedModelList?.find((model) => model.id === id)
}

export function supportsNativeMessages(id: string): boolean {
  return modelInfo(id)?.endpoints.includes("/v1/messages") ?? false
}

interface RawModel {
  id?: string
  name?: string
  slug?: string
  supported_endpoints?: string[]
  model_picker_enabled?: boolean
  policy?: { state?: string }
  capabilities?: {
    type?: string
    family?: string
    limits?: { max_prompt_tokens?: number; max_context_window_tokens?: number }
    supports?: { reasoning_effort?: string[] }
  }
}

function rawToModel(raw: RawModel, allowNonGpt = false): UpstreamModel | null {
  const id = raw.id ?? raw.slug
  if (!id || (!allowNonGpt && !allowedModel(id))) return null
  const limits = raw.capabilities?.limits
  return {
    id,
    name: raw.name ?? id,
    endpoints: allowNonGpt
      ? (raw.supported_endpoints ?? [])
      : ["/responses"],
    efforts: raw.capabilities?.supports?.reasoning_effort ?? null,
    maxPromptTokens: limits?.max_prompt_tokens,
    maxContextTokens: limits?.max_context_window_tokens,
    policyState: raw.policy?.state,
    pickerEnabled: raw.model_picker_enabled,
    type: raw.capabilities?.type ?? "chat",
    family: raw.capabilities?.family ?? id,
  }
}

let softFailure: string | null = null

export function takeDiscoverySoftFailure(): string | null {
  const result = softFailure
  softFailure = null
  return result
}

function pick(ids: string[], pattern: RegExp, fallback: string): string {
  return ids.find((id) => pattern.test(id)) ?? fallback
}

export async function discoverModels(): Promise<ModelMapping> {
  softFailure = null
  const defaults = selectedCatalog()
  let models = defaults

  // The mock server can provide a model payload, which keeps the complete
  // adapter path testable without contacting auth.openai.com or ChatGPT.
  if (isMockMode()) {
    try {
      const identity = await getOpenAIIdentity()
      const response = await openaiFetch(`${openaiBaseUrl()}/models`, {
        headers: openaiRequestHeaders(identity.access, identity.accountId),
        signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) {
        const body = (await response.json()) as { data?: RawModel[]; models?: RawModel[] }
        const discovered = (body.models ?? body.data ?? [])
          .map((raw) => rawToModel(raw, true))
          .filter((m): m is UpstreamModel => m !== null)
        if (discovered.length > 0) models = discovered
      }
    } catch (err) {
      if (isTlsTrustError(err)) throw err
      softFailure = `[clgpt] mock model discovery failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  cachedModelList = models
  const ids = models.map((model) => model.id)
  setModelAliases(new Map(models.flatMap((model) => {
    const advertised = advertisedId(model.id)
    return advertised && advertised !== model.id ? [[advertised, model.id] as [string, string]] : []
  })))
  const fallback = ids.find((id) => allowedModel(id)) ?? (isMockMode() ? ids[0] : undefined)
  if (!fallback) throw new Error("No allowlisted GPT models are available")
  const override = (name: string): string | undefined => {
    const value = process.env[name]?.trim()
    return value && ids.includes(value) && (isMockMode() || allowedModel(value)) ? value : undefined
  }
  const mapping: ModelMapping = {
    opus: override("CLGPT_OPUS") ?? pick(ids, /^gpt-6|^gpt-5\.6-sol/, fallback),
    sonnet: override("CLGPT_SONNET") ?? fallback,
    haiku: override("CLGPT_HAIKU") ?? pick(ids, /^gpt-5\.6-luna|^gpt-5\.5/, fallback),
    fable: override("CLGPT_FABLE") ?? fallback,
  }
  return mapping
}
