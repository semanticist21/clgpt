// OpenAI ChatGPT subscription endpoints and request identity.

import { caBundle } from "./tls"

export const OPENAI_ISSUER = "https://auth.openai.com"
export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"

export function openaiFetch(url: string, init?: RequestInit): Promise<Response> {
  const ca = caBundle()
  return fetch(url, ca ? { ...init, tls: { ca } } : init)
}

// Test/dev hook: point the adapter at a local mock upstream; OAuth is skipped.
export function mockUpstream(): string | undefined {
  const value = process.env.CLGPT_UPSTREAM?.trim()
  return value ? value : undefined
}

export function isMockMode(): boolean {
  return mockUpstream() !== undefined
}

export function openaiBaseUrl(): string {
  return mockUpstream() ?? CODEX_API_ENDPOINT.replace(/\/responses$/, "")
}

export function openaiRequestHeaders(
  token: string,
  accountId?: string,
  opts?: {
    agentInitiated?: boolean
    sessionId?: string
    residency?: string
    accept?: string
  },
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: opts?.accept ?? "application/json",
    originator: "clgpt",
    "user-agent": "clgpt/0.1.0",
    "session-id": opts?.sessionId ?? crypto.randomUUID(),
    "x-initiator": opts?.agentInitiated ? "agent" : "user",
  }
  if (accountId) headers["chatgpt-account-id"] = accountId
  if (opts?.residency) headers["x-openai-internal-codex-residency"] = opts.residency
  return headers
}
