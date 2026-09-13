// Minimal mock ChatGPT upstream for end-to-end testing without ChatGPT auth.
// Usage: bun run scripts/mock-upstream.ts [port]   then
//        CLGPT_UPSTREAM=http://127.0.0.1:<port> clgpt ...

const port = Number(process.argv[2] ?? 9099)

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: async (req) => {
    const url = new URL(req.url)
    if (url.pathname === "/models") {
      const native = ["/v1/messages", "/chat/completions"]
      return Response.json({
        data: [
          // Claude-style models route through the native Anthropic endpoint,
          // exactly as real ChatGPT declares them.
          { id: "mock-opus", supported_endpoints: native },
          { id: "mock-sonnet", supported_endpoints: native },
          { id: "mock-haiku", supported_endpoints: native },
          // Translation-path model, for exercising the chat dialect.
          { id: "mock-chat", supported_endpoints: ["/chat/completions"] },
          { id: "gpt-5.6-sol", supported_endpoints: ["/responses"] },
        ].map((m) => ({
          ...m,
          // Matches production: ChatGPT returns false for every model.
          model_picker_enabled: false,
          policy: { state: "enabled" },
          capabilities: {
            type: "chat",
            family: m.id,
            limits: { max_prompt_tokens: 200000, max_context_window_tokens: 264000 },
            supports: { reasoning_effort: ["low", "medium", "high", "xhigh", "max"] },
          },
        })),
      })
    }

    if (url.pathname === "/v1/messages") {
      const body = (await req.json()) as { stream?: boolean; model: string }
      const text = "Mock native response: OK"
      if (body.stream) {
        return new Response(
          [
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                id: "msg_mock",
                type: "message",
                role: "assistant",
                content: [],
                model: body.model,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 5, output_tokens: 0 },
              },
            })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text },
            })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({
              type: "content_block_stop",
              index: 0,
            })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 6 },
            })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return Response.json({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 6 },
      })
    }

    if (url.pathname === "/responses") {
      const body = (await req.json()) as { stream?: boolean; input?: unknown[]; model: string; tools?: Array<{ name?: string }> }
      const inputText = JSON.stringify(body.input ?? [])
      const hasImage = inputText.includes("input_image")
      const hasToolResult = inputText.includes("function_call_output")
      const toolName = body.tools?.[0]?.name
      const wantsTool = Boolean(toolName && !hasToolResult)
      if (body.stream) {
        const events = wantsTool
          ? [
              { type: "response.output_item.added", item: { type: "function_call", id: "item_mock", call_id: "call_mock", name: toolName, arguments: "" } },
              { type: "response.function_call_arguments.delta", item_id: "item_mock", delta: "{}" },
              { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2 } } },
            ]
          : [
              { type: "response.output_text.delta", delta: hasImage ? "Image received" : "Mock Responses response" },
              { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 3 } } },
            ]
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })
      }
      return Response.json({
        id: "resp_mock",
        model: body.model,
        status: "completed",
        output: wantsTool
          ? [{ type: "function_call", call_id: "call_mock", name: toolName, arguments: "{}" }]
          : [{ type: "message", content: [{ type: "output_text", text: hasImage ? "Image received" : "Mock Responses response" }] }],
        usage: { input_tokens: 5, output_tokens: 3 },
      })
    }

    if (url.pathname !== "/chat/completions") {
      return new Response("not found", { status: 404 })
    }
    const body = (await req.json()) as { stream?: boolean; model: string }
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id: "mock-1",
        model: body.model,
        choices: [{ index: 0, finish_reason: finish, delta }],
      })}\n\n`

    if (body.stream) {
      return new Response(
        [
          chunk({ role: "assistant", content: "Mock upstream response: OK" }),
          chunk({}, "stop"),
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    return Response.json({
      id: "mock-1",
      model: body.model,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Mock upstream response: OK" },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    })
  },
})

console.log(`mock upstream on http://127.0.0.1:${port}`)
