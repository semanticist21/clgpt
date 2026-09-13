// Local Anthropic-compatible adapter server. Claude Code talks to this; it
// translates and forwards to the ChatGPT Codex Responses endpoint.

import { StreamTranslator } from "./stream"
import { estimateTokens, ONE_MILLION_TOKENS, TOKEN_WARNING_RATIO } from "./tokens"
import { DialectRouter, type Dialect } from "./route"
import type { AnthropicRequest, OpenAIRequest, OpenAIResponse, StreamEventData } from "./wire"
import {
  openaiBaseUrl,
  openaiFetch,
  openaiRequestHeaders,
  isMockMode,
} from "./api"
import { isTlsTrustError, tlsHint } from "./tls"
import {
  getOpenAIToken,
  getOpenAIIdentity,
  invalidateOpenAIToken,
  modelInfo,
  upstreamModels,
} from "./token"
import {
  normalizeModel,
  translateRequest,
  translateResponse,
} from "./translate"
import {
  ResponsesEventAdapter,
  responsesToOpenAIResponse,
  toResponsesRequest,
} from "./responses"

export interface ServerHandle {
  url: string
  port: number
  /** Per-process bearer token for the launched Claude client. */
  token: string
  stop(): void
}

export interface ServerOptions {
  port?: number
  /** Override the ChatGPT base URL (tests inject a mock directly).
   *  Implies mock-token mode: no browser OAuth is attempted. */
  upstream?: string
}

// Token injected into claude via ANTHROPIC_AUTH_TOKEN; requests without it
// are rejected so stray local processes (or web pages doing no-cors POSTs)
// cannot burn a ChatGPT subscription through the adapter.
const MAX_BODY_BYTES = 64 * 1024 * 1024

class BodyTooLarge extends Error {}

async function readBoundedBody(req: Request): Promise<string> {
  const declared = req.headers.get("content-length")
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isFinite(length) || length < 0) throw new Error("invalid content-length")
    if (length > MAX_BODY_BYTES) throw new BodyTooLarge()
  }
  if (!req.body) return ""
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) throw new BodyTooLarge()
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

const QUOTA_GUIDANCE =
  "ChatGPT subscription or model access was rejected - check your plan and selected model"

// clgpt appends [1m] to picker rows whose real window exceeds the default
// ceiling, which makes Claude Code request the 1M-context beta. Forward that
// only to a model that genuinely has the window — ChatGPT rejects the header
// otherwise, and the [1m] suffix is the only per-row window channel the
// picker schema offers, so we cannot simply stop using it.
export function sanitizeBeta(
  beta: string | undefined,
  model: string,
): string | undefined {
  if (!beta) return beta
  const window =
    modelInfo(model)?.maxPromptTokens ?? modelInfo(model)?.maxContextTokens
  if ((window ?? 0) >= ONE_MILLION_TOKENS) return beta
  const kept = beta
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v && !v.startsWith("context-1m"))
  return kept.length > 0 ? kept.join(",") : undefined
}

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8)
}

// Request logs go to the terminal in serve mode; in run mode claude's TUI
// owns stdout/stderr, so the sink is silenced (or redirected to a file
// under CLGPT_DEBUG) to keep the chat view clean.
let logSink: ((line: string) => void) | null = (line) => console.log(line)

export function setAdapterLogSink(
  sink: ((line: string) => void) | null,
): void {
  logSink = sink
}

function logLine(line: string): void {
  logSink?.(line)
}

function safeLogModel(model: unknown): string {
  return String(model ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
    .slice(0, 120)
}

function debug(...args: unknown[]): void {
  if (process.env.CLGPT_DEBUG) console.error("[clgpt:debug]", ...args)
}

function anthropicError(status: number, message: string): Response {
  const type =
    status === 401 || status === 403
      ? "authentication_error"
      : status === 429
        ? "rate_limit_error"
        : status === 404
          ? "not_found_error"
          : status === 400 || status === 402 || status === 413 || status === 422
            ? "invalid_request_error" // terminal — Claude Code must not retry
            : "api_error"
  return Response.json(
    { type: "error", error: { type, message } },
    { status },
  )
}

// Turn a raw upstream error body into an actionable message: known error
// codes get guidance; the raw body is debug-gated to avoid leaking upstream
// internals into terminals and pasted bug reports.
function friendlyUpstreamError(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: string; code?: string | number }
    }
    const message = parsed?.error?.message
    if (
      parsed?.error?.code === "quota_exceeded" ||
      (message && /quota/i.test(message))
    ) {
      return QUOTA_GUIDANCE
    }
    if (message) return message
  } catch {
    // not JSON — fall through
  }
  if (process.env.CLGPT_DEBUG) {
    return `upstream error: ${bodyText.slice(0, 500)}`
  }
  return "upstream error (set CLGPT_DEBUG=1 for the raw body)"
}

function detectVision(payload: OpenAIRequest): boolean {
  return payload.messages.some((m) =>
    typeof m.content !== "string" && Array.isArray(m.content)
      ? m.content.some((p) => p.type === "image_url")
      : false,
  )
}

const routes = new DialectRouter()

type ChatResult =
  | { ok: true; res: Response; dialect: Dialect }
  | { ok: false; status: number; message: string }

/** The request as Claude Code sent it, for the native passthrough path. */
interface NativeRequest {
  body: string
  anthropicVersion?: string
  anthropicBeta?: string
}

async function openaiChat(
  payload: OpenAIRequest,
  anthropic: AnthropicRequest,
  upstreamBase: string,
  mockToken: boolean,
  native?: NativeRequest,
  allowedEfforts?: string[] | null,
): Promise<ChatResult> {
  const chatBody = JSON.stringify(payload)
  const agentInitiated = payload.messages.some(
    (m) => m.role === "assistant" || m.role === "tool",
  )
  const vision = detectVision(payload)

  const info = modelInfo(payload.model)
  let dialect = routes.select(payload.model, info, native !== undefined && !process.env.CLGPT_NO_PASSTHROUGH)
  let attempt = 0
  while (attempt < 2) {
    const identity = mockToken
      ? { access: "mock", accountId: undefined, residency: undefined }
      : await getOpenAIIdentity(attempt > 0)
    const token = identity.access
    const endpoint = dialect === "native"
      ? "/v1/messages"
      : dialect === "responses"
        ? "/responses"
        : "/chat/completions"
    const headers = openaiRequestHeaders(token, identity.accountId, {
      agentInitiated,
      residency: identity.residency,
      accept: payload.stream ? "text/event-stream" : "application/json",
    })
    if (dialect === "native" && native) {
      // Forward the protocol headers verbatim; the upstream needs them to
      // honour the same betas Claude Code asked for.
      if (native.anthropicVersion) headers["anthropic-version"] = native.anthropicVersion
      const beta = sanitizeBeta(native.anthropicBeta, payload.model)
      if (beta) headers["anthropic-beta"] = beta
    }
    const res = await openaiFetch(`${upstreamBase}${endpoint}`, {
      method: "POST",
      headers,
      body: dialect === "native"
        ? native!.body
        : dialect === "responses"
          ? JSON.stringify(toResponsesRequest(anthropic, allowedEfforts))
          : chatBody,
    })

    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      // Free the parked socket before retrying with a fresh token.
      await res.body?.cancel().catch(() => {})
      invalidateOpenAIToken()
      attempt++
      continue
    }

    if (res.ok) {
      return {
        ok: true,
        res,
        dialect,
      }
    }

    const text = await res.text()
    // A shape rejection falls back for this request. Only model/endpoint
    // evidence changes future routing. Quota, auth and rate-limit failures
    // are not shape problems, so they surface
    // as-is rather than burning a second upstream call.
    if (
      dialect === "native" &&
      [400, 404, 415, 422].includes(res.status)
    ) {
      debug("native /v1/messages rejected:", res.status)
      const remembered = routes.rejectNative(payload.model, res.status, text)
      dialect = routes.translated(payload.model, info)
      logLine(`[${timestamp()}]   -> ${safeLogModel(payload.model)}: native rejected (${res.status}); ${dialect} fallback ${remembered ? "remembered for this process" : "for this request only"}`)
      continue
    }
    // The upstream may expose some models only via the Responses API; switch and
    // retry within the same attempt budget.
    if (
      res.status === 400 &&
      dialect === "chat" &&
      /chat\/completions endpoint/i.test(text)
    ) {
      routes.requireResponses(payload.model)
      dialect = "responses"
      continue
    }
    return { ok: false, status: res.status, message: friendlyUpstreamError(text) }
  }
  return { ok: false, status: 502, message: "upstream retry exhausted" }
}

// Parse the upstream SSE stream into Anthropic SSE events. The "responses"
// dialect first maps Responses events onto OpenAI-style chunks so the same
// StreamTranslator renders both.
function sseResponse(
  upstream: Response,
  model: string,
  dialect: "chat" | "responses" = "chat",
): Response {
  const translator = new StreamTranslator(model)
  const eventAdapter =
    dialect === "responses" ? new ResponsesEventAdapter() : null
  // Held in the closure so client disconnects can cancel the upstream read
  // (upstream.body.cancel() would fail: the stream is locked by the reader).
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      let closed = false
      const send = (event: StreamEventData) => {
        if (closed) return
        try {
          controller.enqueue(
            enc.encode(
              `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
            ),
          )
        } catch {
          closed = true
        }
      }
      const stop = () => {
        closed = true
      }

      // Flush headers immediately and keep the connection warm while the
      // upstream thinks; Claude Code aborts a silent stream after 300s.
      send({ event: "ping", data: { type: "ping" } })
      const pinger = setInterval(
        () => send({ event: "ping", data: { type: "ping" } }),
        15000,
      )

      try {
        reader = upstream.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        let errored = false
        readLoop: while (true) {
          const { done, value } = await reader.read()
          if (closed) break
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
          if (done && buffer) buffer += "\n"
          let idx: number
          while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx).replace(/\r$/, "")
            buffer = buffer.slice(idx + 1)
            if (!line.startsWith("data:")) continue
            const data = line.slice(5).trim()
            if (!data || data === "[DONE]") continue

            let parsed: unknown
            try {
              parsed = JSON.parse(data)
            } catch {
              debug("unparsable upstream SSE line, bytes:", data.length)
              continue
            }
            let obj = parsed as OpenAIResponse
            if (eventAdapter) {
              const chunk = eventAdapter.pushEvent(parsed as Record<string, unknown>)
              if (!chunk) continue
              obj = chunk
            }
            if (obj && typeof obj === "object" && obj.error) {
              // In-band upstream error (quota, entitlement, moderation).
              // The error event is terminal — no fake message termination
              // after it, so the client cannot mistake this for success.
              debug("upstream error chunk, code:", obj.error.code ?? "unknown")
              errored = true
              const message = (obj.error.message as string | undefined) ?? ""
              const isQuota =
                (obj.error.code as string | undefined) === "quota_exceeded" ||
                /quota/i.test(message)
              send({
                event: "error",
                data: {
                  type: "error",
                  error: {
                    type: isQuota ? "invalid_request_error" : "api_error",
                    message: isQuota
                      ? QUOTA_GUIDANCE
                      : message || `upstream error chunk (see CLGPT_DEBUG)`,
                  },
                },
              })
              break readLoop
            }
            if (!Array.isArray(obj?.choices)) {
              debug("non-conforming upstream chunk, bytes:", data.length)
              continue
            }
            for (const ev of translator.pushChunk(obj)) send(ev)
            if (closed) break readLoop
          }
          if (done) break
        }
        if (!errored) {
          for (const ev of translator.finish()) send(ev)
        }
      } catch (err) {
        send({
          event: "error",
          data: {
            type: "error",
            error: { type: "api_error", message: String(err) },
          },
        })
      } finally {
        clearInterval(pinger)
        stop()
        try {
          controller.close()
        } catch {
          // already closed by client cancellation
        }
      }
    },
    cancel() {
      reader?.cancel().catch(() => {})
    },
  })
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  })
}

const HEADERLESS_SSE_PEEK_BYTES = 16 * 1024

function hasResponsesSseFrame(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") continue
    try {
      const event = JSON.parse(data) as { type?: unknown }
      if (event && typeof event === "object" && typeof event.type === "string") return true
    } catch {
      // Keep peeking in case the JSON line was split across upstream chunks.
    }
  }
  return false
}

/**
 * The Codex Responses endpoint omits Content-Type, so validate a bounded
 * prefix before handing it to the streaming translator. The prefix is then
 * replayed so no event is lost.
 */
export async function peekHeaderlessSse(upstream: Response): Promise<Response | null> {
  if (!upstream.body) return null
  const reader = upstream.body.getReader()
  const chunks: Uint8Array[] = []
  let inspectedBytes = 0
  let framing = ""
  const decoder = new TextDecoder()

  try {
    while (inspectedBytes < HEADERLESS_SSE_PEEK_BYTES) {
      const { done, value } = await reader.read()
      if (done) {
        framing += decoder.decode()
        break
      }
      if (!value?.length) continue
      chunks.push(value)
      const sample = value.subarray(0, HEADERLESS_SSE_PEEK_BYTES - inspectedBytes)
      inspectedBytes += sample.length
      framing += decoder.decode(sample, { stream: true })
      if (hasResponsesSseFrame(framing)) break
      // Do not inspect beyond the bounded prefix. The complete chunk remains
      // in `chunks` and will be replayed if a valid frame was found earlier.
      if (sample.length < value.length) break
    }
  } catch {
    await reader.cancel().catch(() => {})
    return null
  }

  if (!hasResponsesSseFrame(framing)) {
    await reader.cancel().catch(() => {})
    return null
  }

  const replay = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const chunk of chunks) controller.enqueue(chunk)
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value?.length) controller.enqueue(value)
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })
  return new Response(replay, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  })
}

async function handleMessages(
  req: Request,
  upstreamBase: string,
  mockToken: boolean,
): Promise<Response> {
  const started = Date.now()
  // Read the body as text so the native path can forward it essentially
  // untouched; the parse is only for inspection and the translation paths.
  let rawBody: string
  let payload: AnthropicRequest
  try {
    rawBody = await readBoundedBody(req)
    payload = JSON.parse(rawBody) as AnthropicRequest
  } catch (err) {
    if (err instanceof BodyTooLarge) return anthropicError(413, "request body too large")
    return anthropicError(400, "invalid JSON body")
  }
  const stream = payload.stream === true
  logLine(
    `[${timestamp()}] POST /v1/messages model=${safeLogModel(payload.model)} stream=${stream}`,
  )

  const info = modelInfo(normalizeModel(payload.model))
  if (!isMockMode() && !info) {
    return anthropicError(400, "model is not in clgpt's allowlisted ChatGPT catalog")
  }
  const allowedEfforts = info?.efforts ?? null
  // The local estimate cannot establish overflow across different tokenizers.
  // Keep requests flowing; the selected upstream is authoritative about fit.
  const limit = info?.maxPromptTokens ?? info?.maxContextTokens
  if (limit) {
    const estimate = estimateTokens(payload)
    if (estimate > limit * TOKEN_WARNING_RATIO) {
      logLine(`[${timestamp()}]   -> warning: estimated input ~${estimate}, ${safeLogModel(payload.model)} limit ${limit}; forwarding to upstream`)
    }
  }
  const upstreamPayload = translateRequest(payload, allowedEfforts)
  // Only the model name is rewritten for the native path; every other field
  // (thinking, cache_control, output_config, tools) rides through as sent.
  const nativeBody =
    payload.model === upstreamPayload.model
      ? rawBody
      : JSON.stringify({ ...payload, model: upstreamPayload.model })
  let result: Awaited<ReturnType<typeof openaiChat>>
  try {
    result = await openaiChat(
      upstreamPayload,
      payload,
      upstreamBase,
      mockToken,
      {
        body: nativeBody,
        anthropicVersion: req.headers.get("anthropic-version") ?? undefined,
        anthropicBeta: req.headers.get("anthropic-beta") ?? undefined,
      },
      allowedEfforts,
    )
  } catch (err) {
    // This is the only place a TLS failure can reach the user: it renders as
    // an API error inside claude's UI, so the remedy has to travel with it.
    const detail = String(err)
    logLine(`[${timestamp()}]   -> upstream request failed: ${detail}`)
    return anthropicError(
      502,
      `upstream request failed: ${detail}` +
        (isTlsTrustError(err) ? tlsHint() : ""),
    )
  }
  if (!result.ok) {
    logLine(`[${timestamp()}]   -> HTTP ${result.status} (${Date.now() - started}ms)`)
    return anthropicError(result.status, result.message)
  }
  const res = result.res

  if (result.dialect === "native") {
    // Already Anthropic-shaped: relay verbatim, streaming included.
    logLine(
      `[${timestamp()}]   -> ${res.status} native${stream ? " streaming" : ""} (${Date.now() - started}ms)`,
    )
    const headers: Record<string, string> = {
      "content-type": res.headers.get("content-type") ?? "application/json",
    }
    if (stream) {
      headers["cache-control"] = "no-cache"
      headers["x-accel-buffering"] = "no"
    }
    return new Response(res.body, { status: res.status, headers })
  }

  if (!stream) {
    let data: OpenAIResponse
    try {
      const raw = (await res.json()) as unknown
      if (result.dialect === "responses") {
        const body = raw as {
          error?: unknown
          status?: string
        }
        // An in-band failure body must not convert into an empty
        // "successful" assistant message.
        if (body?.error || body?.status === "failed") {
          logLine(
            `[${timestamp()}]   -> responses error body (${Date.now() - started}ms)`,
          )
          return anthropicError(
            502,
            `upstream error: ${JSON.stringify(body.error ?? body.status).slice(0, 300)}`,
          )
        }
        data = responsesToOpenAIResponse(raw as Record<string, unknown>)
      } else {
        data = raw as OpenAIResponse
      }
    } catch {
      // A 200 with a non-JSON body (proxy page, HTML error) is an upstream
      // failure, not a client error — must be terminal 502, not a retryable
      // 500.
      return anthropicError(502, "upstream returned a non-JSON body")
    }
    if (data && typeof data === "object" && data.error) {
      logLine(`[${timestamp()}]   -> upstream error body (${Date.now() - started}ms)`)
      return anthropicError(
        502,
        `upstream error: ${JSON.stringify(data.error).slice(0, 500)}`,
      )
    }
    if (!Array.isArray(data?.choices)) {
      return anthropicError(502, "upstream returned a non-conforming response")
    }
    logLine(`[${timestamp()}]   -> 200 (${Date.now() - started}ms)`)
    return Response.json(translateResponse(data))
  }

  // A 200 that is not actually an SSE stream is an error body, not a message.
  const contentType = res.headers.get("content-type") ?? ""
  let streamResponse = res
  if (!contentType.includes("text/event-stream") && result.dialect === "responses" && !contentType) {
    streamResponse = await peekHeaderlessSse(res) ?? res
    if (streamResponse === res) {
      logLine(
        `[${timestamp()}]   -> 200 non-SSE body: ${contentType} (${Date.now() - started}ms)`,
      )
      return anthropicError(502, "upstream returned non-streaming body")
    }
  } else if (!contentType.includes("text/event-stream")) {
    const detail = (await res.text()).slice(0, 500)
    logLine(
      `[${timestamp()}]   -> 200 non-SSE body: ${contentType} (${Date.now() - started}ms)`,
    )
    return anthropicError(502, `upstream returned non-streaming body: ${detail}`)
  }

  logLine(`[${timestamp()}]   -> 200 streaming (${result.dialect})`)
  return sseResponse(streamResponse, upstreamPayload.model, result.dialect)
}

// Bun derives req.url from the client-supplied Host header, so comparing
// the Host header against url.host is a tautology. Compare against the
// origin we actually bound instead.
function authorize(req: Request, selfHost: string, localToken: string): Response | null {
  if (req.headers.get("host") !== selfHost) {
    return anthropicError(403, "host header mismatch")
  }
  if (req.headers.get("authorization") !== `Bearer ${localToken}`) {
    return anthropicError(401, "missing or invalid adapter token")
  }
  return null
}

async function handle(
  req: Request,
  upstreamBase: string,
  mockToken: boolean,
  selfHost: string,
  localToken: string,
): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === "/api/hello") {
    // Claude Code's connection-warming probe; auth keeps it from being a
    // port-scan oracle. Rejecting it is harmless by design.
    return authorize(req, selfHost, localToken) ?? new Response(null, { status: 200 })
  }

  if (path !== "/v1/messages" && path !== "/v1/messages/count_tokens") {
    if (req.method === "GET" && path === "/v1/models") {
      const denied = authorize(req, selfHost, localToken)
      if (denied) return denied
      // Gateway model discovery (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY):
      // serve the list captured at startup — Claude Code aborts discovery
      // after 3 seconds, so a live upstream fetch would silently fail.
      logLine(`[${timestamp()}] GET /v1/models`)
      const entries = upstreamModels()
      if (entries.length === 0) {
        return anthropicError(502, "model list unavailable (discovery failed at startup)")
      }
      return Response.json({
        data: entries.map((e) => ({
          type: "model",
          id: e.id,
          display_name: e.name,
        })),
        has_more: false,
      })
    }
    return anthropicError(404, `not found: ${req.method} ${path}`)
  }
  if (req.method !== "POST") {
    return anthropicError(404, `not found: ${req.method} ${path}`)
  }
  const denied = authorize(req, selfHost, localToken)
  if (denied) return denied

  const contentType = req.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) {
    return anthropicError(400, "content-type must be application/json")
  }
  if (path === "/v1/messages/count_tokens") {
    try {
      const payload = JSON.parse(await readBoundedBody(req)) as AnthropicRequest
      logLine(`[${timestamp()}] POST /v1/messages/count_tokens`)
      return Response.json({ input_tokens: estimateTokens(payload) })
    } catch (err) {
      if (err instanceof BodyTooLarge) return anthropicError(413, "request body too large")
      return anthropicError(400, "invalid JSON body")
    }
  }

  return handleMessages(req, upstreamBase, mockToken)
}

export async function startServer(
  opts: ServerOptions = {},
): Promise<ServerHandle> {
  const upstreamBase = (opts.upstream ?? openaiBaseUrl()).replace(/\/$/, "")
  const mockToken = opts.upstream !== undefined || isMockMode()
  const localToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
  // Filled in once the port is bound; the fetch closure only runs afterwards.
  let selfHost = ""
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch: (req) =>
      handle(req, upstreamBase, mockToken, selfHost, localToken).catch((err) =>
        anthropicError(500, String(err)),
      ),
  })
  selfHost = `127.0.0.1:${server.port ?? 0}`
  return {
    url: server.url.toString().replace(/\/$/, ""),
    port: server.port ?? 0,
    token: localToken,
    stop: () => server.stop(true),
  }
}

// Imported lazily by name to keep the module graph simple.
