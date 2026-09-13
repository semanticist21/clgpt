// Integration test: the adapter server against a mock ChatGPT upstream,
// injected explicitly (no process.env mutation). Covers routing, auth,
// non-streaming, streaming SSE (including in-band errors and usage-only
// terminal chunks), count_tokens, and error mapping — no ChatGPT auth.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { remapToSessionSlot } from "../src/server"
import {
  peekHeaderlessSse,
  sanitizeBeta,
  startServer,
  setAdapterLogSink,
  type ServerHandle,
} from "../src/server"
import { discoverModels, upstreamModels } from "../src/token"
import { buildModelPickerFrom } from "../src/spawn"

let upstream: ReturnType<typeof Bun.serve>
let adapter: ServerHandle
const nativeCalls: Array<{
  body: string
  beta: string | null
  version: string | null
}> = []
const responsesCalls: Array<{ model: string; service_tier?: string }> = []

const auth = (server: ServerHandle = adapter) => ({ authorization: `Bearer ${server.token}` })
/** Every upstream path the adapter actually hit, in order. */
const upstreamPaths: string[] = []

const chunkLine = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "1",
    model: "mock-sonnet",
    choices: [{ index: 0, finish_reason: finish, delta }],
  })}`

const parseEvents = (text: string) =>
  text
    .split("\n\n")
    .filter((b) => b.startsWith("event:"))
    .map((block) => {
      const [event = "", data = ""] = block.split("\ndata: ")
      return {
        name: event.replace("event: ", ""),
        data: data ? (JSON.parse(data) as Record<string, unknown>) : {},
      }
    })

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      upstreamPaths.push(url.pathname)
      if (url.pathname === "/responses") {
        const body = (await req.json()) as {
          stream?: boolean
          model: string
          instructions?: string
          input?: unknown[]
          service_tier?: string
        }
        responsesCalls.push(body)
        if (req.headers.get("originator") !== "clgpt") {
          return new Response("missing header", { status: 400 })
        }
        if (body.stream) {
          const lines = [
            'data: {"type":"response.output_text.delta","delta":"Luna"}',
            "",
            'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"c1","id":"fc_1","name":"Read"}}',
            "",
            'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"f\\":1}"}',
            "",
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":6,"output_tokens":3}}}',
            "",
            "data: [DONE]",
            "",
          ].join("\n")
          // The real ChatGPT Codex Responses endpoint sends SSE without a
          // Content-Type header.
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(lines))
              controller.close()
            },
          }))
        }
        return Response.json({
          id: "resp1",
          model: body.model,
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Luna non-stream" }],
            },
          ],
          usage: { input_tokens: 6, output_tokens: 2 },
        })
      }
      if (url.pathname === "/v1/messages") {
        nativeCalls.push({
          body: await req.text(),
          beta: req.headers.get("anthropic-beta"),
          version: req.headers.get("anthropic-version"),
        })
        const model = JSON.parse(nativeCalls[nativeCalls.length - 1]!.body).model
        if (model === "mock-native-reject") {
          return Response.json(
            { type: "error", error: { message: "The requested model is not supported", code: "model_not_supported" } },
            { status: 400 },
          )
        }
        if (model === "mock-native-temporary" && nativeCalls.length === 1) {
          return Response.json({ error: { message: "unsupported parameter: temperature" } }, { status: 400 })
        }
        if (JSON.parse(nativeCalls[nativeCalls.length - 1]!.body).stream) {
          return new Response(
            [
              'event: message_start',
              'data: {"type":"message_start","message":{"id":"msg_n","type":"message","role":"assistant","content":[],"model":"mock-native","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
              "",
              "event: content_block_start",
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
              "",
              "event: content_block_delta",
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"native hi"}}',
              "",
              "event: message_stop",
              'data: {"type":"message_stop"}',
              "",
            ].join("\n"),
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        return Response.json({
          id: "msg_n",
          type: "message",
          role: "assistant",
          model: "mock-native",
          content: [{ type: "text", text: "native non-stream" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 2 },
        })
      }
      if (url.pathname === "/models") {
        return Response.json({
          data: [
            // Production shape: ChatGPT returns model_picker_enabled:false for
            // every model, which is why honouring it emptied /model entirely.
            { id: "mock-sonnet", name: "Mock Sonnet", model_picker_enabled: false },
            { id: "mock-opus", name: "Mock Opus", model_picker_enabled: false },
            { id: "mock-luna", model_picker_enabled: false },
            {
              id: "mock-native",
              name: "Mock Native",
              supported_endpoints: ["/v1/messages", "/chat/completions"],
              model_picker_enabled: false,
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                family: "mock-native",
                limits: { max_prompt_tokens: 200000, max_context_window_tokens: 264000 },
                supports: { reasoning_effort: ["low", "medium", "high"] },
              },
            },
            {
              id: "mock-native-reject",
              supported_endpoints: ["/v1/messages", "/chat/completions"],
              model_picker_enabled: false,
            },
            {
              id: "mock-native-temporary",
              supported_endpoints: ["/v1/messages", "/chat/completions"],
              model_picker_enabled: false,
            },
            ...["success", "unauthorized"].map((suffix) => ({
              id: `mock-native-retry-${suffix}`,
              supported_endpoints: ["/v1/messages", "/chat/completions"],
              model_picker_enabled: false,
            })),
            // The real GPT-5.x "luna" shape: Responses API only.
            {
              id: "mock-responses-only",
              supported_endpoints: ["/responses"],
              model_picker_enabled: false,
            },
          ],
        })
      }
      if (url.pathname !== "/chat/completions") {
        return new Response("not found", { status: 404 })
      }
      if (req.headers.get("originator") !== "clgpt") {
        return new Response("missing header", { status: 400 })
      }
      const body = (await req.json()) as {
        stream?: boolean
        model: string
        messages: Array<{ role: string; content: unknown }>
      }
      if (body.model === "mock-luna") {
        return Response.json(
          {
            error: {
              message:
                'model "mock-luna" is not accessible via the /chat/completions endpoint',
            },
          },
          { status: 400 },
        )
      }
      if (body.model === "trigger-400") {
        return Response.json(
          { error: { message: "bad schema" } },
          { status: 400 },
        )
      }
      if (body.model === "trigger-402") {
        return Response.json(
          {
            error: {
              message: "You have exceeded your monthly quota",
              code: "quota_exceeded",
            },
          },
          { status: 402 },
        )
      }
      if (body.model === "trigger-html") {
        return new Response("<html>gateway error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      }
      const lastUser = [...body.messages].reverse().find((m) => m.role === "user")
      const wantsError =
        typeof lastUser?.content === "string" &&
        (lastUser.content as string).includes("ERROR")

      if (body.stream) {
        const lines = wantsError
          ? [
              chunkLine({ role: "assistant", content: "let me" }),
              "",
              `data: ${JSON.stringify({ error: { message: "quota exhausted" } })}`,
              "",
              "data: [DONE]",
              "",
            ]
          : [
              chunkLine({ role: "assistant", content: "Hello" }),
              "",
              chunkLine({ content: " world" }),
              "",
              // Real include_usage order: finish_reason chunk, THEN the
              // usage-only terminal chunk (choices: []).
              chunkLine({}, "stop"),
              "",
              `data: ${JSON.stringify({
                id: "1",
                model: "mock-sonnet",
                choices: [],
                usage: { prompt_tokens: 10, completion_tokens: 4 },
              })}`,
              "",
              "data: [DONE]",
              "",
            ]
        return new Response(lines.join("\n"), {
          headers: { "content-type": "text/event-stream" },
        })
      }
      return Response.json({
        id: "1",
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Hi there" },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      })
    },
  })
  adapter = await startServer({ upstream: upstream.url.href.replace(/\/$/, "") })
  // Populate the startup model cache the same way cli.ts does (env-scoped to
  // the mock; the server itself uses the explicit upstream injection).
  process.env.CLGPT_UPSTREAM = upstream.url.href.replace(/\/$/, "")
  await discoverModels()
})

afterAll(() => {
  adapter.stop()
  upstream.stop(true)
  delete process.env.CLGPT_UPSTREAM
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${adapter.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth(), ...headers },
    body: JSON.stringify(body),
  })

describe("adapter server", () => {
  test("requires the injected bearer token (no port-scan oracle)", async () => {
    const hello = await fetch(`${adapter.url}/api/hello`)
    expect(hello.status).toBe(401)
    const noAuth = await fetch(`${adapter.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(noAuth.status).toBe(401)
    const body = (await noAuth.json()) as { error: { type: string } }
    expect(body.error.type).toBe("authentication_error")
  })

  test("rejects non-JSON content types", async () => {
    const res = await fetch(`${adapter.url}/v1/messages`, {
      method: "POST",
      headers: { ...auth(), "content-type": "text/plain" },
      body: JSON.stringify({ model: "m", messages: [] }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("invalid_request_error")
  })

  test("returns Anthropic-shaped 404 for unknown paths", async () => {
    const res = await post("/nope", {})
    expect(res.status).toBe(404)
    const body = (await res.json()) as { type: string; error: { type: string } }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("not_found_error")
  })

  test("non-streaming /v1/messages translates OpenAI -> Anthropic", async () => {
    const res = await post("/v1/messages?beta=true", {
      model: "mock-sonnet",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      type: string
      role: string
      content: Array<{ type: string; text?: string }>
      stop_reason: string
      usage: { input_tokens: number; output_tokens: number }
    }
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    expect(body.content[0]).toEqual({ type: "text", text: "Hi there" })
    expect(body.stop_reason).toBe("end_turn")
    expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 2 })
  })

  test("streaming /v1/messages emits spec-shaped Anthropic SSE events", async () => {
    const res = await post("/v1/messages", {
      model: "mock-sonnet",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const events = parseEvents(await res.text())
    const names = events.map((e) => e.name)

    expect(names[0]).toBe("ping")
    expect(names).toContain("message_start")
    expect(names).toContain("content_block_start")
    expect(names).toContain("content_block_delta")
    expect(names).toContain("content_block_stop")
    expect(names).toContain("message_delta")
    expect(names[names.length - 1]).toBe("message_stop")

    // Exact shapes (pinned against the Anthropic streaming spec).
    const start = events.find((e) => e.name === "message_start")!
    expect(start.data).toMatchObject({
      type: "message_start",
      message: {
        type: "message",
        role: "assistant",
        content: [],
        model: "mock-sonnet",
        stop_reason: null,
        stop_sequence: null,
      },
    })
    const blockStart = events.find((e) => e.name === "content_block_start")!
    expect(blockStart.data).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })

    // Concatenated text deltas reconstruct the upstream text.
    const joined = events
      .filter(
        (e) =>
          e.name === "content_block_delta" &&
          (e.data.delta as Record<string, unknown>).type === "text_delta",
      )
      .map((e) => (e.data.delta as Record<string, unknown>).text)
      .join("")
    expect(joined).toBe("Hello world")

    // Usage arrived via the usage-only terminal chunk (choices: []).
    const delta = events.find((e) => e.name === "message_delta")!
    expect(delta.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 10, output_tokens: 4 },
    })
  })

  test("in-band upstream error chunk becomes a terminal SSE error event", async () => {
    const res = await post("/v1/messages", {
      model: "mock-sonnet",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "ERROR please" }],
    })
    expect(res.status).toBe(200)
    const events = parseEvents(await res.text())
    const errorIdx = events.findIndex((e) => e.name === "error")
    expect(errorIdx).toBeGreaterThan(-1)
    // quota_exceeded gets the actionable guidance message.
    const err = events[errorIdx]!.data.error as Record<string, unknown>
    expect(err.type).toBe("invalid_request_error")
    expect(err.message).toContain("ChatGPT subscription or model access")
    // Error is terminal: no fake message_stop after it.
    expect(events.slice(errorIdx).map((e) => e.name)).not.toContain("message_stop")
  })

  test("HTTP 402 quota_exceeded maps to a terminal error with guidance", async () => {
    const res = await post("/v1/messages", {
      model: "trigger-402",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(402)
    const body = (await res.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("ChatGPT subscription or model access")
  })

  test("spoofed Host header is rejected (403)", async () => {
    const res = await fetch(`${adapter.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...auth(),
        host: "evil.example.com:9",
      },
      body: "{}",
    })
    expect(res.status).toBe(403)
  })

  test("non-stream 200 with non-JSON body maps to terminal 502", async () => {
    const res = await post("/v1/messages", {
      model: "trigger-html",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("api_error")
  })

  test("upstream 400 maps to terminal invalid_request_error", async () => {
    const res = await post("/v1/messages", {
      model: "trigger-400",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("invalid_request_error")
  })

  test("count_tokens returns an estimate", async () => {
    const res = await post("/v1/messages/count_tokens", {
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "x".repeat(350) }],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { input_tokens: number }
    expect(body.input_tokens).toBeGreaterThan(50)
  })

  test("openaiBaseUrl uses the mock upstream and Codex endpoint", async () => {
    const { openaiBaseUrl } = await import("../src/api")
    expect(openaiBaseUrl()).toBe(process.env.CLGPT_UPSTREAM!.replace(/\/$/, ""))
    delete process.env.CLGPT_UPSTREAM
    expect(openaiBaseUrl()).toBe("https://chatgpt.com/backend-api/codex")
    process.env.CLGPT_UPSTREAM = upstream.url.toString()
  })

  test("GET /v1/models proxies the upstream list for model discovery", async () => {
    const res = await fetch(`${adapter.url}/v1/models?limit=1000`, {
      headers: auth(),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ type: string; id: string; display_name: string }>
      has_more: boolean
    }
    expect(body.has_more).toBe(false)
    expect(body.data.slice(0, 3)).toEqual([
      { type: "model", id: "mock-sonnet", display_name: "Mock Sonnet" },
      { type: "model", id: "mock-opus", display_name: "Mock Opus" },
      { type: "model", id: "mock-luna", display_name: "mock-luna" },
    ])
    expect(body.data.map((m) => m.id)).toContain("mock-native")
    // Discovery requires the bearer token like every other endpoint.
    const noAuth = await fetch(`${adapter.url}/v1/models`)
    expect(noAuth.status).toBe(401)
  })

  test("Responses-only models fall back transparently (streaming)", async () => {
    const res = await post("/v1/messages", {
      model: "mock-luna",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const events = parseEvents(await res.text())
    const joined = events
      .filter(
        (e) =>
          e.name === "content_block_delta" &&
          (e.data.delta as Record<string, unknown>).type === "text_delta",
      )
      .map((e) => (e.data.delta as Record<string, unknown>).text)
      .join("")
    expect(joined).toBe("Luna")
    const toolStart = events.find(
      (e) =>
        e.name === "content_block_start" &&
        ((e.data as Record<string, unknown>).content_block as Record<
          string,
          unknown
        >).type === "tool_use",
    )
    expect(toolStart).toBeDefined()
    const delta = events.find((e) => e.name === "message_delta")!
    expect(
      ((delta.data as Record<string, unknown>).delta as Record<string, unknown>)
        .stop_reason,
    ).toBe("tool_use")
    expect((delta.data as Record<string, unknown>).usage).toEqual({
      input_tokens: 6,
      output_tokens: 3,
    })
  })

  test("Responses-only models fall back transparently (non-streaming)", async () => {
    const res = await post("/v1/messages", {
      model: "mock-luna",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      content: Array<{ type: string; text?: string }>
      stop_reason: string
      usage: { input_tokens: number; output_tokens: number }
    }
    expect(body.content[0]).toEqual({ type: "text", text: "Luna non-stream" })
    expect(body.stop_reason).toBe("end_turn")
    expect(body.usage).toEqual({ input_tokens: 6, output_tokens: 2 })
  })

  test("Fast mode reaches the Responses upstream as a service tier", async () => {
    responsesCalls.length = 0
    const res = await post("/v1/messages", {
      model: "mock-responses-only",
      max_tokens: 32,
      speed: "fast",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    expect(responsesCalls.at(-1)?.service_tier).toBe("fast")
  })

  test("headerless Responses streams are peeked before translation", async () => {
    const sse = new Response('event: response.created\ndata: {"type":"response.created"}\n\n')
    sse.headers.delete("content-type")
    const checked = await peekHeaderlessSse(sse)
    expect(checked).not.toBeNull()
    expect(await checked!.text()).toContain("event: response.created")

    const html = new Response("<html>gateway error</html>")
    html.headers.delete("content-type")
    expect(await peekHeaderlessSse(html)).toBeNull()

    const invalid = new Response("data: gateway error\n\n")
    invalid.headers.delete("content-type")
    expect(await peekHeaderlessSse(invalid)).toBeNull()

    const oversized = new Uint8Array(64 * 1024)
    const frame = new TextEncoder().encode('data: {"type":"response.created"}\n\n')
    oversized.set(frame)
    const large = new Response(oversized)
    large.headers.delete("content-type")
    const checkedLarge = await peekHeaderlessSse(large)
    expect(checkedLarge).not.toBeNull()
    expect((await checkedLarge!.arrayBuffer()).byteLength).toBe(oversized.byteLength)

    const longEvent = new Response(`data: {"type":"response.created","response":{"blob":"${"x".repeat(20 * 1024)}"}}\n\n`)
    longEvent.headers.delete("content-type")
    expect(await peekHeaderlessSse(longEvent)).not.toBeNull()
  })

  test("headerless non-SSE Responses bodies map to terminal 502", async () => {
    const mock = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<html>gateway error</html>"))
          controller.close()
        },
      })),
    })
    const server = await startServer({ upstream: mock.url.origin })
    try {
      const res = await fetch(`${server.url}/v1/messages`, {
        method: "POST",
        headers: { ...auth(server), "content-type": "application/json" },
        body: JSON.stringify({
          model: "mock-responses-only",
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      })
      expect(res.status).toBe(502)
      expect((await res.json()).error.message).toContain("non-streaming body")
    } finally {
      server.stop()
      mock.stop(true)
    }
  })

  test("native models stream straight through, untranslated", async () => {
    nativeCalls.length = 0
    const res = await fetch(`${adapter.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...auth(),
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "some-beta,another-beta",
      },
      body: JSON.stringify({
        model: "mock-native",
        max_tokens: 32,
        stream: true,
        // Fields the translation path would drop must survive verbatim.
        thinking: { type: "enabled", budget_tokens: 1024 },
        output_config: { effort: "high" },
        system: [
          { type: "text", text: "be brief", cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // Relayed as-is: Anthropic SSE the adapter never re-encoded.
    expect(text).toContain('"type":"message_start"')
    expect(text).toContain("native hi")

    expect(nativeCalls).toHaveLength(1)
    const call = nativeCalls[0]!
    expect(call.version).toBe("2023-06-01")
    expect(call.beta).toBe("some-beta,another-beta")
    const sent = JSON.parse(call.body)
    expect(sent.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
    expect(sent.output_config).toEqual({ effort: "high" })
    expect(sent.system[0].cache_control).toEqual({ type: "ephemeral" })
  })

  test("native models also relay non-streaming responses verbatim", async () => {
    nativeCalls.length = 0
    const res = await post("/v1/messages", {
      model: "mock-native",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      type: string
      content: Array<{ type: string; text: string }>
      usage: { input_tokens: number; output_tokens: number }
    }
    expect(body.type).toBe("message")
    expect(body.content[0]).toEqual({ type: "text", text: "native non-stream" })
    expect(body.usage).toEqual({ input_tokens: 3, output_tokens: 2 })
  })

  test("a rejected native attempt falls back to the translation path", async () => {
    nativeCalls.length = 0
    const res = await post("/v1/messages", {
      model: "mock-native-reject",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    // Native was tried once, then the chat dialect answered.
    expect(nativeCalls).toHaveLength(1)
    const body = (await res.json()) as { content: Array<{ text: string }> }
    expect(body.content[0]!.text).toBe("Hi there")

    // The rejection is remembered: no second native attempt.
    nativeCalls.length = 0
    const again = await post("/v1/messages", {
      model: "mock-native-reject",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(again.status).toBe(200)
    expect(nativeCalls).toHaveLength(0)
  })

  test("a parameter rejection falls back once without poisoning later native requests", async () => {
    nativeCalls.length = 0
    const payload = { model: "mock-native-temporary", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }
    const first = await post("/v1/messages", payload)
    expect(first.status).toBe(200)
    expect((await first.json()).content[0].text).toBe("Hi there")
    const second = await post("/v1/messages", payload)
    expect(second.status).toBe(200)
    expect((await second.json()).content[0].text).toBe("native non-stream")
    expect(nativeCalls).toHaveLength(2)
  })

  test("upstream connection failures map to Anthropic error bodies", async () => {
    const dead = await startServer({ upstream: "http://127.0.0.1:1" })
    const res = await fetch(`${dead.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(dead) },
      body: JSON.stringify({
        model: "m",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    dead.stop()
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("api_error")
  })
})

describe("sanitizeBeta", () => {
  test("drops the 1M-context beta for a model that lacks the window", () => {
    // [1m] on a picker row makes claude ask for this beta; forwarding it to a
    // model without the window makes ChatGPT reject the whole request.
    expect(sanitizeBeta("context-1m-2025-08-07", "mock-chat")).toBeUndefined()
    expect(
      sanitizeBeta("other-beta,context-1m-2025-08-07", "mock-chat"),
    ).toBe("other-beta")
  })

  test("leaves unrelated betas and absent headers alone", () => {
    expect(sanitizeBeta("some-beta", "mock-chat")).toBe("some-beta")
    expect(sanitizeBeta(undefined, "mock-chat")).toBeUndefined()
  })
})

describe("dialect routing", () => {
  test("a responses-only model is not probed on /chat/completions first", async () => {
    upstreamPaths.length = 0
    const res = await fetch(`${adapter.url}/v1/messages`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-responses-only",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    // /models declares this model as /responses-only, so guessing chat first
    // would burn one upstream request per model — a real charge on a metered
    // plan. The learned fallback still covers a wrong declaration.
    expect(upstreamPaths).toEqual(["/responses"])
  })
})

describe("the picker against a raw /models payload", () => {
  // The bug this whole feature exists to fix lived in the mapping from
  // model_picker_enabled to pickerEnabled, which no test crossed: every
  // picker test hand-built its own objects. A filter reintroduced at the
  // token.ts layer would leave /model empty with the suite still green.
  test("a payload with picker disabled everywhere still yields a lineup", async () => {
    const models = upstreamModels()
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => m.pickerEnabled === false)).toBe(true)
    const picker = buildModelPickerFrom(models)
    expect(picker).not.toBeNull()
    expect(picker!.options.length).toBe(
      models.filter((m) => m.type === undefined || m.type === "chat").length,
    )
  })
})

describe("upstream SSE at EOF", () => {
  test.each(["", "\n", "\r\n", "\n\n"])("terminal usage survives ending %j", async (ending) => {
    const terminal = { id: "1", model: "m", choices: [], usage: { prompt_tokens: 45000, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40000 } } }
    const text = chunkLine({ content: "한글" }, "stop") + "\n\n" + `data: ${JSON.stringify(terminal)}` + ending
    const bytes = new TextEncoder().encode(text)
    const mock = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(new ReadableStream({
      start(controller) {
        // Split every byte, including UTF-8 code points and CRLF delimiters.
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    }), { headers: { "content-type": "text/event-stream" } }) })
    const server = await startServer({ upstream: mock.url.origin })
    try {
      const res = await fetch(`${server.url}/v1/messages`, { method: "POST", headers: { ...auth(server), "content-type": "application/json" }, body: JSON.stringify({ model: "m", stream: true, max_tokens: 32, messages: [{ role: "user", content: "hi" }] }) })
      const events = parseEvents(await res.text())
      expect(events.find((e) => e.name === "message_delta")?.data.usage).toEqual({ input_tokens: 5000, cache_read_input_tokens: 40000, output_tokens: 7 })
      expect(events.filter((e) => e.name === "message_stop")).toHaveLength(1)
      expect(events.find((e) => e.name === "content_block_delta")?.data.delta).toEqual({ type: "text_delta", text: "한글" })
    } finally {
      server.stop()
      mock.stop(true)
    }
  })
})

describe("estimated input budget", () => {
  test("a large estimate warns without blocking a request the upstream accepts", async () => {
    const logs: string[] = []
    setAdapterLogSink((line) => logs.push(line))
    nativeCalls.length = 0
    try {
      const res = await post("/v1/messages", {
        model: "mock-native", max_tokens: 32,
        messages: [{ role: "user", content: "x".repeat(800000) }],
      })
      expect(res.status).toBe(200)
      expect((await res.json()).content[0].text).toBe("native non-stream")
      expect(nativeCalls).toHaveLength(1)
      expect(logs.some((line) => line.includes("warning: estimated input") && line.includes("forwarding to upstream"))).toBe(true)
    } finally {
      setAdapterLogSink((line) => console.log(line))
    }
  })
})

describe("terminal SSE records without a newline", () => {
  test.each(["chat", "responses"])("%s keeps an explicit tool completion at EOF", async (dialect) => {
    const records = dialect === "chat" ? [
      { id: "1", model: "m", choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: "{}" } }] } }] },
      { id: "1", model: "m", choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }] },
    ] : [
      { type: "response.output_item.added", item: { type: "function_call", id: "f1", call_id: "c1", name: "Read" } },
      { type: "response.function_call_arguments.delta", item_id: "f1", delta: "{}" },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } },
    ]
    const mock = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(records.map((r) => `data: ${JSON.stringify(r)}`).join("\n\n"), { headers: { "content-type": "text/event-stream" } }) })
    const server = await startServer({ upstream: mock.url.origin })
    try {
      const res = await fetch(`${server.url}/v1/messages`, {
        method: "POST", headers: { ...auth(server), "content-type": "application/json" },
        body: JSON.stringify({ model: dialect === "responses" ? "mock-responses-only" : "m", max_tokens: 32, stream: true, messages: [{ role: "user", content: "hi" }] }),
      })
      const events = parseEvents(await res.text())
      expect(events.find((e) => e.name === "message_delta")?.data.delta).toEqual({ stop_reason: "tool_use", stop_sequence: null })
      expect(events.filter((e) => e.name === "message_stop")).toHaveLength(1)
    } finally {
      server.stop()
      mock.stop(true)
    }
  })

  test("an error at EOF is terminal, without a fake message_stop", async () => {
    const mock = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response('data: {"error":{"message":"upstream failed"}}', { headers: { "content-type": "text/event-stream" } }) })
    const server = await startServer({ upstream: mock.url.origin })
    try {
      const res = await fetch(`${server.url}/v1/messages`, {
        method: "POST", headers: { ...auth(server), "content-type": "application/json" },
        body: JSON.stringify({ model: "m", max_tokens: 32, stream: true, messages: [{ role: "user", content: "hi" }] }),
      })
      expect(parseEvents(await res.text()).map((e) => e.name)).toEqual(["ping", "error"])
    } finally {
      server.stop()
      mock.stop(true)
    }
  })
})

describe("auth retry across dialect fallbacks", () => {
  test.each(["success", "unauthorized"])("one auth retry stays bounded through native/chat/Responses: %s", async (outcome) => {
    const paths: string[] = []
    const mock = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
      paths.push(new URL(req.url).pathname)
      if (paths.length === 1) return new Response("expired", { status: 401 })
      if (paths.length === 2) return Response.json({ error: { code: "model_not_supported" } }, { status: 400 })
      if (paths.length === 3) return Response.json({ error: { message: "model is not accessible via the /chat/completions endpoint" } }, { status: 400 })
      if (outcome === "unauthorized") return new Response("still expired", { status: 401 })
      return Response.json({ id: "r", output: [{ type: "message", content: [{ type: "output_text", text: "recovered" }] }] })
    } })
    const server = await startServer({ upstream: mock.url.origin })
    try {
      const res = await fetch(`${server.url}/v1/messages`, {
        method: "POST", headers: { ...auth(server), "content-type": "application/json" },
        body: JSON.stringify({ model: `mock-native-retry-${outcome}`, max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
      })
      expect(res.status).toBe(outcome === "success" ? 200 : 401)
      if (outcome === "success") expect((await res.json()).content[0].text).toBe("recovered")
      else await res.text()
      expect(paths).toEqual(["/v1/messages", "/v1/messages", "/chat/completions", "/responses"])
    } finally {
      server.stop()
      mock.stop(true)
    }
  })
})

describe("remapToSessionSlot", () => {
  const models = { opus: "gpt-6-astra", sonnet: "gpt-6-astra", haiku: "gpt-5.6-luna", fable: "gpt-6-astra" }
  test("maps Claude's subagent model names onto the session slots", () => {
    expect(remapToSessionSlot("claude-haiku-4.5", models)).toBe("gpt-5.6-luna")
    expect(remapToSessionSlot("claude-sonnet-5", models)).toBe("gpt-6-astra")
  })
  test("leaves catalog models and tier-less unknowns alone", () => {
    expect(remapToSessionSlot("gpt-5.3-codex-spark", models)).toBe("gpt-5.3-codex-spark")
    expect(remapToSessionSlot("mystery-model", models)).toBe("mystery-model")
  })
})
