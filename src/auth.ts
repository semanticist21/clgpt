// ChatGPT subscription OAuth. Tokens are stored only in clgpt's own config
// file; the Codex CLI credential cache is deliberately not read or modified.

import { createServer } from "node:http"
import {
  CODEX_API_ENDPOINT,
  OPENAI_CLIENT_ID,
  OPENAI_ISSUER,
  isMockMode,
} from "./api"
import { loadAuth, saveAuth, type AuthStore } from "./config"
import { caBundle } from "./tls"

const OAUTH_PORT = 1455
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000
const EXPIRY_MARGIN_MS = 5 * 60 * 1000
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/auth/callback`

export interface OpenAIIdentity extends AuthStore {
  fresh: boolean
}

export interface JwtClaims {
  [key: string]: unknown
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
    chatgpt_compute_residency?: string
  }
  chatgpt_account_id?: string
  chatgpt_compute_residency?: string
  organizations?: Array<{ id?: string }>
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8")
}

export function parseJwtClaims(token: string): JwtClaims | null {
  try {
    const payload = token.split(".")[1]
    if (!payload) return null
    return JSON.parse(base64UrlDecode(payload)) as JwtClaims
  } catch {
    return null
  }
}

export function extractAccountId(claims: JwtClaims | null): string | undefined {
  const nested = claims?.["https://api.openai.com/auth"]
  if (nested && typeof nested.chatgpt_account_id === "string") {
    return nested.chatgpt_account_id
  }
  if (typeof claims?.chatgpt_account_id === "string") return claims.chatgpt_account_id
  const organization = claims?.organizations?.find((item) => typeof item.id === "string")
  return organization?.id
}

export function extractResidency(claims: JwtClaims | null): string | undefined {
  const nested = claims?.["https://api.openai.com/auth"]
  const value = nested?.chatgpt_compute_residency ?? claims?.chatgpt_compute_residency
  return typeof value === "string" && value !== "no_constraint" ? value : undefined
}

function withTls(init: RequestInit = {}): RequestInit {
  const ca = caBundle()
  return ca ? ({ ...init, tls: { ca } } as RequestInit) : init
}

async function openaiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, withTls(init))
}

function tokenError(prefix: string, response: Response, body: TokenResponse): Error {
  return new Error(
    `${prefix}: HTTP ${response.status}${body.error ? ` ${body.error}` : ""}${body.error_description ? ` - ${body.error_description}` : ""}`,
  )
}

async function exchangeToken(body: Record<string, string>): Promise<TokenResponse> {
  const response = await openaiFetch(`${OPENAI_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = (await response.json().catch(() => ({}))) as TokenResponse
  if (!response.ok || typeof parsed.access_token !== "string") {
    throw tokenError("ChatGPT OAuth token exchange failed", response, parsed)
  }
  return parsed
}

export async function refreshOpenAIToken(saved: AuthStore): Promise<AuthStore> {
  const token = await exchangeToken({
    grant_type: "refresh_token",
    refresh_token: saved.refresh,
    client_id: OPENAI_CLIENT_ID,
  })
  const claims = parseJwtClaims(token.id_token ?? token.access_token ?? "")
  const refreshed: AuthStore = {
    access: token.access_token!,
    refresh: token.refresh_token ?? saved.refresh,
    expires: Date.now() + (token.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(claims) ?? saved.accountId,
    residency: extractResidency(claims) ?? saved.residency,
  }
  await saveAuth(refreshed)
  return refreshed
}

function randomVerifier(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
}

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Buffer.from(digest).toString("base64url")
}

export function buildAuthorizeUrl(state: string, challenge: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "clgpt",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  return `${OPENAI_ISSUER}/oauth/authorize?${params}`
}

function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" })
    return
  }
  if (process.platform === "linux") {
    Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" })
  }
}

export async function runOAuth(): Promise<OpenAIIdentity> {
  const verifier = randomVerifier()
  const challenge = await sha256Base64Url(verifier)
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")
  const authorizeUrl = buildAuthorizeUrl(state, challenge)

  const result = await new Promise<{ code: string }>((resolve, reject) => {
    let settled = false
    let server: ReturnType<typeof createServer> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      server?.close()
      callback()
    }
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", REDIRECT_URI)
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404).end("Not found")
        return
      }
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400).end("Invalid OAuth state")
        finish(() => reject(new Error("ChatGPT OAuth state validation failed")))
        return
      }
      const error = url.searchParams.get("error")
      if (error) {
        response.writeHead(400).end("ChatGPT OAuth was cancelled")
        finish(() => reject(new Error(`ChatGPT OAuth failed: ${error}`)))
        return
      }
      const code = url.searchParams.get("code")
      if (!code) {
        response.writeHead(400).end("Missing OAuth code")
        finish(() => reject(new Error("ChatGPT OAuth callback did not include a code")))
        return
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end("<h1>clgpt login complete</h1><p>You can return to the terminal.</p>")
      finish(() => resolve({ code }))
    })
    timer = setTimeout(() => {
      finish(() => reject(new Error("ChatGPT OAuth timed out")))
    }, OAUTH_TIMEOUT_MS)
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        finish(() => reject(new Error(
          `ChatGPT OAuth callback port ${OAUTH_PORT} is already in use; close the other process using it and run clgpt login again`,
        )))
        return
      }
      finish(() => reject(error))
    })
    server.listen(OAUTH_PORT, "127.0.0.1", () => {
      console.log("\nChatGPT authentication required:")
      console.log(`  Open this URL in your browser:\n  ${authorizeUrl}\n`)
      openBrowser(authorizeUrl)
    })
  }).finally(() => {
    // The callback server is intentionally short-lived and only listens on
    // loopback. finish() closes it after the callback or timeout.
  })

  const token = await exchangeToken({
    grant_type: "authorization_code",
    code: result.code,
    redirect_uri: REDIRECT_URI,
    client_id: OPENAI_CLIENT_ID,
    code_verifier: verifier,
  })
  const claims = parseJwtClaims(token.id_token ?? token.access_token ?? "")
  const auth: AuthStore = {
    access: token.access_token!,
    refresh: token.refresh_token ?? "",
    expires: Date.now() + (token.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(claims),
    residency: extractResidency(claims),
  }
  if (!auth.refresh) throw new Error("ChatGPT OAuth did not return a refresh token")
  await saveAuth(auth)
  return { ...auth, fresh: true }
}

export async function ensureOpenAIToken(force = false): Promise<OpenAIIdentity> {
  if (isMockMode()) {
    return { access: "mock", refresh: "mock", expires: Date.now() + 3600_000, fresh: false }
  }
  const saved = await loadAuth()
  if (!force && saved && saved.expires > Date.now() + EXPIRY_MARGIN_MS) {
    return { ...saved, fresh: false }
  }
  if (saved?.refresh) {
    try {
      return { ...(await refreshOpenAIToken(saved)), fresh: false }
    } catch {
      // A rejected refresh means the browser flow is the only safe recovery.
    }
  }
  return runOAuth()
}

/** MCP must never start an interactive browser flow on its JSON-RPC stdout. */
export async function ensureOpenAITokenForMcp(): Promise<OpenAIIdentity> {
  if (isMockMode()) return { access: "mock", refresh: "mock", expires: Date.now() + 3600_000, fresh: false }
  const saved = await loadAuth()
  if (!saved) throw new Error("ChatGPT authentication is required; run `clgpt login` before using web tools")
  if (saved.expires > Date.now() + EXPIRY_MARGIN_MS) return { ...saved, fresh: false }
  if (!saved.refresh) throw new Error("ChatGPT OAuth session expired; run `clgpt login` before using web tools")
  try { return { ...(await refreshOpenAIToken(saved)), fresh: false } } catch { throw new Error("ChatGPT OAuth refresh failed; run `clgpt login` before using web tools") }
}

export { CODEX_API_ENDPOINT }
