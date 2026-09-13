import { describe, expect, test } from "bun:test"
import { StreamTranslator } from "../src/stream"
import type { OpenAIResponse } from "../src/wire"

describe("StreamTranslator", () => {
  const chunk = (
    delta: Record<string, unknown>,
    finish_reason: string | null = null,
    usage?: OpenAIResponse["usage"],
  ): OpenAIResponse =>
    ({
      id: "1",
      model: "m",
      usage,
      choices: [
        {
          index: 0,
          finish_reason: finish_reason as "stop",
          delta,
        },
      ],
    }) as unknown as OpenAIResponse

  const rawChunk = (body: Record<string, unknown>): OpenAIResponse =>
    body as unknown as OpenAIResponse

  test("streams text deltas into one block, then tool_use with json deltas", () => {
    const t = new StreamTranslator("m")
    const events = [
      ...t.pushChunk(chunk({ role: "assistant", content: "Hel" })),
      ...t.pushChunk(chunk({ content: "lo" })), // must NOT close/reopen block
      ...t.pushChunk(
        chunk({
          tool_calls: [
            { index: 0, id: "call1", function: { name: "Read", arguments: "" } },
          ],
        }),
      ),
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] }),
      ),
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }),
      ),
      ...t.pushChunk(chunk({}, "tool_calls")),
      ...t.finish(),
    ]

    const types = events.map((e) => e.event)
    expect(types[0]).toBe("message_start")
    expect(types[types.length - 1]).toBe("message_stop")

    // text block opened once, appended twice
    const textStarts = events.filter(
      (e) =>
        e.event === "content_block_start" &&
        (e.data as Record<string, unknown>).content_block !== undefined &&
        ((e.data as Record<string, unknown>).content_block as Record<string, unknown>)
          .type === "text",
    )
    expect(textStarts).toHaveLength(1)
    const textDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data as Record<string, unknown>).delta !== undefined &&
        ((e.data as Record<string, unknown>).delta as Record<string, unknown>)
          .type === "text_delta",
    )
    expect(textDeltas).toHaveLength(2)

    // tool_use block: start at index 1, json deltas, then stop
    const toolStart = events.find(
      (e) =>
        e.event === "content_block_start" &&
        ((e.data as Record<string, unknown>).content_block as Record<
          string,
          unknown
        >).type === "tool_use",
    )
    expect(toolStart).toBeDefined()
    const toolStartIdx = (toolStart!.data as Record<string, unknown>).index
    expect(toolStartIdx).toBe(1)
    const jsonDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data as Record<string, unknown>).delta !== undefined &&
        ((e.data as Record<string, unknown>).delta as Record<string, unknown>)
          .type === "input_json_delta",
    )
    const joined = jsonDeltas
      .map(
        (e) =>
          (((e.data as Record<string, unknown>).delta as Record<string, unknown>)
            .partial_json as string),
      )
      .join("")
    expect(joined).toBe('{"a":1}')

    const messageDelta = events.find((e) => e.event === "message_delta")
    expect((messageDelta!.data as Record<string, unknown>).delta).toEqual({
      stop_reason: "tool_use",
      stop_sequence: null,
    })
  })

  test("parallel tool calls: every delta lands between its own start/stop", () => {
    const t = new StreamTranslator("m")
    const events = [
      // Both call headers arrive in ONE chunk.
      ...t.pushChunk(
        chunk({
          tool_calls: [
            { index: 0, id: "call_a", function: { name: "Read", arguments: "" } },
            { index: 1, id: "call_b", function: { name: "Bash", arguments: "" } },
          ],
        }),
      ),
      // Interleaved argument fragments.
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }),
      ),
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 1, function: { arguments: '{"b":2}' } }] }),
      ),
      ...t.pushChunk(chunk({}, "tool_calls")),
      ...t.finish(),
    ]

    // For every content_block_index, no input_json_delta may appear after its
    // content_block_stop (order-aware walk).
    const closed = new Set<number>()
    for (const e of events) {
      const index = (e.data as Record<string, unknown>).index as number
      if (e.event === "content_block_stop") {
        closed.add(index)
        continue
      }
      if (e.event !== "content_block_delta") continue
      const delta = (e.data as Record<string, unknown>).delta as Record<
        string,
        unknown
      >
      if (delta.type === "input_json_delta") {
        expect(closed.has(index)).toBe(false)
      }
    }

    const toolStarts = events.filter(
      (e) =>
        e.event === "content_block_start" &&
        ((e.data as Record<string, unknown>).content_block as Record<
          string,
          unknown
        >).type === "tool_use",
    )
    expect(toolStarts).toHaveLength(2)
    // No text block preceded: tool blocks take indices 0 and 1.
    expect((toolStarts[0]!.data as Record<string, unknown>).index).toBe(0)
    expect((toolStarts[1]!.data as Record<string, unknown>).index).toBe(1)

    const allJson = events
      .filter(
        (e) =>
          e.event === "content_block_delta" &&
          ((e.data as Record<string, unknown>).delta as Record<string, unknown>)
            .type === "input_json_delta",
      )
      .map(
        (e) =>
          (((e.data as Record<string, unknown>).delta as Record<string, unknown>)
            .partial_json as string),
      )
      .join("")
    expect(allJson).toBe('{"a":1}{"b":2}')
  })

  test("tool-call fragment with id only is not dropped; buffered args flush on start", () => {
    const t = new StreamTranslator("m")
    const events = [
      // id and arguments arrive BEFORE the function name.
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 0, id: "call_x", function: { arguments: '{"pre"' } }] }),
      ),
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 0, function: { name: "Read" } }] }),
      ),
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
      ),
      ...t.pushChunk(chunk({}, "tool_calls")),
      ...t.finish(),
    ]
    const toolStart = events.find(
      (e) =>
        e.event === "content_block_start" &&
        ((e.data as Record<string, unknown>).content_block as Record<
          string,
          unknown
        >).type === "tool_use",
    )
    expect(toolStart).toBeDefined()
    expect(
      ((toolStart!.data as Record<string, unknown>).content_block as Record<
        string,
        unknown
      >).id,
    ).toBe("call_x")
    const allJson = events
      .filter(
        (e) =>
          e.event === "content_block_delta" &&
          ((e.data as Record<string, unknown>).delta as Record<string, unknown>)
            .type === "input_json_delta",
      )
      .map(
        (e) =>
          (((e.data as Record<string, unknown>).delta as Record<string, unknown>)
            .partial_json as string),
      )
      .join("")
    expect(allJson).toBe('{"pre":1}')
    const messageDelta = events.find((e) => e.event === "message_delta")
    expect(
      ((messageDelta!.data as Record<string, unknown>).delta as Record<
        string,
        unknown
      >).stop_reason,
    ).toBe("tool_use")
  })

  test("text after tool calls closes tool blocks first with sequential indices", () => {
    const t = new StreamTranslator("m")
    const events = [
      ...t.pushChunk(
        chunk({
          tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: "{}" } }],
        }),
      ),
      ...t.pushChunk(chunk({ content: "done" })),
    ]
    const stops = events
      .filter((e) => e.event === "content_block_stop")
      .map((e) => (e.data as Record<string, unknown>).index)
    expect(stops).toEqual([0]) // tool block (index 0) closed when text started
    const textDeltaIdx = (
      events.find(
        (e) =>
          e.event === "content_block_delta" &&
          ((e.data as Record<string, unknown>).delta as Record<string, unknown>)
            .type === "text_delta",
      )!.data as Record<string, unknown>
    ).index
    expect(textDeltaIdx).toBe(1)
  })

  test("usage-only terminal chunk AFTER finish_reason feeds message_delta (real order)", () => {
    const t = new StreamTranslator("m")
    const events = [
      ...t.pushChunk(chunk({ content: "hi" })),
      // Real include_usage order: finish_reason FIRST, usage-only chunk LAST.
      ...t.pushChunk(chunk({}, "stop")),
      ...t.pushChunk(
        rawChunk({ id: "1", model: "m", choices: [], usage: { prompt_tokens: 9, completion_tokens: 7 } }),
      ),
      ...t.finish(),
    ]
    const messageDelta = events.find((e) => e.event === "message_delta")
    expect((messageDelta!.data as Record<string, unknown>).usage).toEqual({
      input_tokens: 9,
      output_tokens: 7,
    })
    expect(
      ((messageDelta!.data as Record<string, unknown>).delta as Record<string, unknown>)
        .stop_reason,
    ).toBe("end_turn")
  })

  test("message_start is emitted exactly once regardless of chunk count", () => {
    const t = new StreamTranslator("m")
    const events = [
      ...t.pushChunk(chunk({ content: "a" })),
      ...t.pushChunk(chunk({ content: "b" })),
      ...t.pushChunk(chunk({ content: "c" })),
      ...t.pushChunk(chunk({}, "stop")),
      ...t.finish(),
    ]
    expect(events.filter((e) => e.event === "message_start")).toHaveLength(1)
  })

  test("chunks after the stream closed are ignored", () => {
    const t = new StreamTranslator("m")
    t.pushChunk(chunk({ content: "x" }))
    t.finish()
    expect(t.pushChunk(chunk({ content: "late" }))).toEqual([])
  })

  test("error-key chunk (no choices) is skipped without throwing", () => {
    const t = new StreamTranslator("m")
    expect(() =>
      t.pushChunk(rawChunk({ error: { message: "quota exhausted" } })),
    ).not.toThrow()
  })

  test("finish() closes an unterminated stream as max_tokens (truncation)", () => {
    const t = new StreamTranslator("m")
    const events = [...t.pushChunk(chunk({ content: "par" })), ...t.finish()]
    const types = events.map((e) => e.event)
    expect(types[0]).toBe("message_start")
    expect(types[types.length - 1]).toBe("message_stop")
    const messageDelta = events.find((e) => e.event === "message_delta")
    expect(
      ((messageDelta!.data as Record<string, unknown>).delta as Record<
        string,
        unknown
      >).stop_reason,
    ).toBe("max_tokens")
  })

  test("finish() with no chunks still emits a complete empty message", () => {
    const t = new StreamTranslator("m")
    const events = t.finish()
    const types = events.map((e) => e.event)
    expect(types).toEqual(["message_start", "message_delta", "message_stop"])
    // Exact Anthropic shapes (pinned, not just event names).
    const start = events[0]!.data as Record<string, unknown>
    expect(start.type).toBe("message_start")
    const message = start.message as Record<string, unknown>
    expect(message).toMatchObject({
      type: "message",
      role: "assistant",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    const delta = events[1]!.data as Record<string, unknown>
    expect(delta).toEqual({
      type: "message_delta",
      delta: { stop_reason: "max_tokens", stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 },
    })
  })
})

describe("missing upstream completion signal", () => {
  test.each(['{"path":', '{"path":"/tmp/x"}'])("tool arguments %s alone do not prove completion", (args) => {
    const translator = new StreamTranslator("m")
    translator.pushChunk({ id: "1", model: "m", choices: [{ index: 0, finish_reason: null,
      delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: args } }] },
    }] })
    const events = translator.finish()
    expect(events.find((e) => e.event === "message_delta")?.data.delta).toEqual({ stop_reason: "max_tokens", stop_sequence: null })
    expect(translator.finish()).toEqual([])
  })

  test("explicit length beats an already-started tool call", () => {
    const translator = new StreamTranslator("m")
    translator.pushChunk({ id: "1", model: "m", choices: [{ index: 0, finish_reason: "length",
      delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: '{}' } }] },
    }] })
    expect(translator.finish().find((e) => e.event === "message_delta")?.data.delta)
      .toEqual({ stop_reason: "max_tokens", stop_sequence: null })
  })
})
