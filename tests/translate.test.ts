import type { AnthropicRequest } from "../src/wire"

import { describe, expect, test } from "bun:test"
import { advertisedId } from "../src/catalog"
import { setModelAliases } from "../src/translate"
import {
  normalizeModel,
  translateRequest,
  translateResponse,
} from "../src/translate"

describe("translateRequest", () => {
  test("degrades a tool_choice pinned to a schema-less server tool", () => {
    const out = translateRequest({
      model: "claude-sonnet-4.5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "web_search", type: "web_search_20250305" },
        { name: "read_file", description: "reads", input_schema: { type: "object", properties: {} } },
      ],
      tool_choice: { type: "tool", name: "web_search" },
    } as unknown as Parameters<typeof translateRequest>[0])
    expect(out.tool_choice).toBe("auto")
  })

  test("merges system blocks into a single system message", () => {
    const out = translateRequest({
      model: "claude-sonnet-4.5",
      max_tokens: 100,
      system: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.messages).toEqual([
      { role: "system", content: "a\n\nb" },
      { role: "user", content: "hi" },
    ])
    expect(out.max_tokens).toBe(100)
  })

  test("emits tool results before user text", () => {
    const out = translateRequest({
      model: "claude-sonnet-4.5",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            {
              type: "tool_use",
              id: "t1",
              name: "Read",
              input: { file_path: "/x" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "file body" }],
            },
            { type: "text", text: "and also" },
          ],
        },
      ],
    })
    expect(out.messages).toEqual([
      {
        role: "assistant",
        content: "let me check",
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "Read", arguments: '{"file_path":"/x"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "file body" },
      { role: "user", content: "and also" },
    ])
  })

  test("folds assistant thinking into text and drops request thinking", () => {
    const out = translateRequest({
      model: "claude-sonnet-4.5",
      max_tokens: 100,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "go on" },
      ],
    })
    expect("thinking" in out).toBe(false)
    expect(out.messages[0]).toEqual({ role: "assistant", content: "hmm\n\nanswer" })
  })

  test("maps tools and tool_choice", () => {
    const out = translateRequest({
      model: "claude-sonnet-4.5",
      max_tokens: 100,
      tool_choice: { type: "any" },
      tools: [
        {
          name: "Read",
          description: "read a file",
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "Read",
          description: "read a file",
          parameters: { type: "object", properties: {} },
        },
      },
    ])
    expect(out.tool_choice).toBe("required")
  })

  test("tool_result is_error gets an [error] prefix", () => {
    const out = translateRequest({
      model: "m",
      max_tokens: 1,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content: "boom",
            },
          ],
        },
      ],
    })
    expect(out.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "t1",
      content: "[error] boom",
    })
  })

  test("images in tool_result move to the adjacent user message (tool stays string)", () => {
    const out = translateRequest({
      model: "m",
      max_tokens: 1,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "screenshot:" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              ],
            },
          ],
        },
      ],
    })
    const tool = out.messages[0] as { role: string; content: unknown }
    expect(tool.role).toBe("tool")
    expect(typeof tool.content).toBe("string")
    expect(tool.content).toContain("[1 image(s)")
    const user = out.messages[1] as unknown as {
      role: string
      content: Array<Record<string, unknown>>
    }
    expect(user.role).toBe("user")
    expect(user.content[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    })
  })

  test("empty stop_sequences coerce to null; streaming sets stream_options", () => {
    const out = translateRequest({
      model: "m",
      max_tokens: 1,
      stop_sequences: [],
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.stop).toBeNull()
    expect(out.stream_options).toEqual({ include_usage: true })
    const nonStream = translateRequest({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(nonStream.stream_options).toBeUndefined()
  })

  test("effort is sent only when the model declares that value", () => {
    const base = {
      model: "m",
      max_tokens: 8,
      messages: [{ role: "user" as const, content: "hi" }],
      output_config: { effort: "xhigh" },
    }
    // ChatGPT publishes the accepted values per model in /models capabilities.
    expect(translateRequest(base, ["low", "medium", "high", "xhigh"]).reasoning_effort).toBe(
      "xhigh",
    )
    expect(translateRequest(base, ["low", "medium", "high"]).reasoning_effort).toBeUndefined()
    expect(translateRequest(base, null).reasoning_effort).toBeUndefined()
    expect(translateRequest(base).reasoning_effort).toBeUndefined()
    expect(
      translateRequest({ ...base, output_config: undefined }, ["xhigh"]).reasoning_effort,
    ).toBeUndefined()
  })

  test("cache_control markers become ChatGPT's prompt_cache_control", () => {
    const out = translateRequest({
      model: "m",
      max_tokens: 8,
      system: [
        { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "cached", cache_control: { type: "ephemeral" } },
          ],
        },
        { role: "user", content: [{ type: "text", text: "plain" }] },
      ],
    })
    expect(out.messages[0]).toMatchObject({
      role: "system",
      prompt_cache_control: { type: "ephemeral" },
    })
    expect(out.messages[1]).toMatchObject({
      content: "cached",
      prompt_cache_control: { type: "ephemeral" },
    })
    expect(out.messages[2]!.prompt_cache_control).toBeUndefined()
  })

  test("normalizeModel strips date/bracket suffixes and dot-ifies known slugs", () => {
    expect(normalizeModel("claude-sonnet-4.5")).toBe("claude-sonnet-4.5")
    expect(normalizeModel("claude-sonnet-4-5-20250929")).toBe(
      "claude-sonnet-4.5",
    )
    expect(normalizeModel("claude-opus-4-1-20250805")).toBe("claude-opus-4.1")
    expect(normalizeModel("claude-sonnet-4-5[1m]")).toBe("claude-sonnet-4.5")
    expect(normalizeModel("claude-3-5-sonnet-20241022")).toBe(
      "claude-3.5-sonnet",
    )
    expect(normalizeModel("claude-3-7-sonnet")).toBe("claude-3.7-sonnet")
    expect(normalizeModel("gpt-5")).toBe("gpt-5")
  })
})

describe("translateResponse", () => {
  test("maps text, tool calls, stop reason, and usage cache", () => {
    const out = translateResponse({
      id: "r1",
      model: "claude-sonnet-4.5",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "reading",
            tool_calls: [
              {
                id: "call1",
                type: "function",
                function: { name: "Read", arguments: '{"file_path":"/x"}' },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    })
    expect(out.stop_reason).toBe("tool_use")
    expect(out.content).toEqual([
      { type: "text", text: "reading" },
      {
        type: "tool_use",
        id: "call1",
        name: "Read",
        input: { file_path: "/x" },
      },
    ])
    expect(out.usage).toEqual({
      input_tokens: 60,
      output_tokens: 20,
      cache_read_input_tokens: 40,
    })
  })

  test("maps finish reasons", () => {
    const mk = (finish: "stop" | "length" | "tool_calls" | "content_filter" | null) =>
      translateResponse({
        id: "r",
        model: "m",
        choices: [
          {
            index: 0,
            finish_reason: finish,
            message: { role: "assistant", content: "x" },
          },
        ],
      }).stop_reason
    expect(mk("stop")).toBe("end_turn")
    expect(mk("length")).toBe("max_tokens")
    expect(mk("content_filter")).toBe("end_turn")
    // tool_calls without any tool_use block downgrades to end_turn (covered
    // explicitly in the next test); with tool calls it stays tool_use.
    expect(mk(null)).toBeNull()
  })

  test("downgrades tool_use stop reason when no tool block was emitted", () => {
    const out = translateResponse({
      id: "r",
      model: "m",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: { role: "assistant", content: "x" },
        },
      ],
    })
    expect(out.stop_reason).toBe("end_turn")
  })

  test("never returns an empty content array", () => {
    const out = translateResponse({
      id: "r",
      model: "m",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: null },
        },
      ],
    })
    expect(out.content).toEqual([{ type: "text", text: "" }])
  })
})

describe("model alias table", () => {
  test("advertised ids resolve to their upstream slug, ahead of the patterns", () => {
    setModelAliases(new Map([["claude-fable-5-1", "claude-fable-5.1"]]))
    // The pattern rules never handled the fable family, so without the table
    // this slug reached ChatGPT verbatim and 400'd.
    expect(normalizeModel("claude-fable-5-1")).toBe("claude-fable-5.1")
    // Suffixes are stripped before the lookup.
    expect(normalizeModel("claude-fable-5-1[1m]")).toBe("claude-fable-5.1")
    setModelAliases(new Map())
  })

  test("falls back to the pattern rules for ids discovery never saw", () => {
    setModelAliases(new Map())
    expect(normalizeModel("claude-haiku-4-5")).toBe("claude-haiku-4.5")
    expect(normalizeModel("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4.5")
  })

  test("an advertised id never collides with a real upstream id", () => {
    const upstream = [
      "claude-haiku-4.5",
      "claude-opus-4.8",
      "claude-opus-4.8-fast",
      "claude-sonnet-5",
      "gpt-6-astra",
    ]
    for (const id of upstream) {
      const advertised = advertisedId(id)
      if (advertised && advertised !== id) {
        expect(upstream).not.toContain(advertised)
      }
    }
  })
})
