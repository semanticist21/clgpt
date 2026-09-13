// The Responses-API fallback: models ChatGPT serves only via POST /responses
// (GPT-5.x "luna" family) must work transparently, both streaming and not.

import { describe, expect, test } from "bun:test"
import { setModelAliases } from "../src/translate"
import type { AnthropicRequest } from "../src/wire"
import {
  toResponsesRequest,
  ResponsesEventAdapter,
  responsesToOpenAIResponse,
} from "../src/responses"

describe("toResponsesRequest", () => {
  test("normalizes advertised aliases and bracket suffixes", () => {
    setModelAliases(new Map([["advertised-gpt", "gpt-upstream"]]))
    try {
      expect(toResponsesRequest({ model: "advertised-gpt[1m]", max_tokens: 1, messages: [] }).model)
        .toBe("gpt-upstream")
    } finally {
      setModelAliases(new Map())
    }
  })

  test("names unsupported blocks in messages and nested tool results", () => {
    const document = { type: "document", title: "report.pdf", source: { type: "base64", data: "PDF" } }
    const out = toResponsesRequest({
      model: "gpt", max_tokens: 1,
      messages: [
        { role: "user", content: [document, { type: "future_block" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [document] }] },
      ],
    } as unknown as AnthropicRequest)
    const content = JSON.stringify(out.input)
    expect(content).toContain("document block was not forwarded")
    expect(content).toContain("future_block block was not forwarded")
    expect(out.input[1].output).toContain("report.pdf")
  })

  test("system -> instructions; tool rounds -> function_call / function_call_output", () => {
    const out = toResponsesRequest({
      model: "gpt-5.6-luna",
      max_tokens: 64,
      system: [{ type: "text", text: "be brief" }],
      tools: [
        { name: "Read", description: "read", input_schema: { type: "object", properties: {} } },
      ],
      tool_choice: { type: "any" },
      messages: [
        { role: "user", content: "read /x" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" },
            { type: "text", text: "go on" },
          ],
        },
      ],
    })
    expect(out.instructions).toBe("be brief")
    expect(out.model).toBe("gpt-5.6-luna")
    expect(out.tools).toEqual([
      { type: "function", name: "Read", description: "read", parameters: { type: "object", properties: {} }, strict: false },
    ])
    expect(out.tool_choice).toBe("required")
    expect(out.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "read /x" }] },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "checking" }],
      },
      { type: "function_call", call_id: "t1", name: "Read", arguments: '{"file_path":"/x"}' },
      { type: "function_call_output", call_id: "t1", output: "[error] boom" },
      { role: "user", content: [{ type: "input_text", text: "go on" }] },
    ])
  })
})

describe("ResponsesEventAdapter", () => {
  test.each(["content_filter", "max_messages", "steered"])("incomplete cause %s is explicit, not token exhaustion", (reason) => {
    const response = { status: "incomplete", incomplete_details: { reason } }
    const adapter = new ResponsesEventAdapter()
    expect(adapter.pushEvent({ type: "response.incomplete", response })?.error?.message).toContain(reason)
    expect(responsesToOpenAIResponse(response).error?.message).toContain(reason)
  })

  test.each([false, true])("incomplete output stays truncated with tools=%s", (tools) => {
    const adapter = new ResponsesEventAdapter()
    const call = { type: "function_call", call_id: "c1", id: "f1", name: "Read", arguments: '{"path":' }
    if (tools) adapter.pushEvent({ type: "response.output_item.added", item: call })
    const response = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: tools ? [call] : [] }
    expect(adapter.pushEvent({ type: "response.incomplete", response })?.choices?.[0].finish_reason).toBe("length")
    expect(responsesToOpenAIResponse(response).choices?.[0].finish_reason).toBe("length")
  })

  test.each(["max_tokens", "max_output_tokens"])("treats %s as normal truncation", (reason) => {
    const response = { status: "incomplete", incomplete_details: { reason } }
    expect(new ResponsesEventAdapter().pushEvent({ type: "response.incomplete", response })?.choices?.[0].finish_reason).toBe("length")
    expect(responsesToOpenAIResponse(response).choices?.[0].finish_reason).toBe("length")
  })

  test("keeps streaming refusals visible", () => {
    const adapter = new ResponsesEventAdapter()
    expect(adapter.pushEvent({ type: "response.refusal.delta", delta: "I cannot help" })?.choices?.[0].delta?.content).toBe("I cannot help")
    expect(adapter.pushEvent({ type: "response.completed", response: {} })?.choices?.[0].finish_reason).toBe("stop")
  })

  test("maps text deltas, tool calls, usage, and failures to OpenAI chunks", () => {
    const adapter = new ResponsesEventAdapter()
    expect(adapter.pushEvent({ type: "response.created" })).toBeNull()

    const text = adapter.pushEvent({ type: "response.output_text.delta", delta: "He" })!
    expect(text!.choices?.[0]?.delta).toEqual({ content: "He" })

    const call = adapter.pushEvent({
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "c1", id: "fc_1", name: "Read" },
    })!
    expect(call!.choices?.[0]?.delta?.tool_calls?.[0]).toMatchObject({
      index: 0,
      id: "c1",
      function: { name: "Read" },
    })

    const args = adapter.pushEvent({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      delta: '{"a":1}',
    })
    expect(args!.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments).toBe('{"a":1}')

    const done = adapter.pushEvent({
      type: "response.completed",
      response: { usage: { input_tokens: 7, output_tokens: 3 } },
    })
    expect(done!.choices?.[0]?.finish_reason).toBe("tool_calls")
    expect(done?.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3 })

    const failed = adapter.pushEvent({
      type: "response.failed",
      response: { error: { message: "quota exhausted" } },
    })
    expect(failed?.error?.message).toBe("quota exhausted")
  })

  test("reasoning.effort is clamped to the model's declared values", () => {
    const base = {
      model: "gpt-5.6-luna",
      max_tokens: 8,
      messages: [{ role: "user" as const, content: "hi" }],
      output_config: { effort: "max" },
    }
    expect(toResponsesRequest(base, ["low", "medium", "high", "max"]).reasoning).toEqual({
      effort: "max",
    })
    expect(toResponsesRequest(base, ["low", "medium", "high"]).reasoning).toBeUndefined()
    expect(toResponsesRequest(base).reasoning).toBeUndefined()
  })

  test("images in tool_result become a placeholder + adjacent input_image user item", () => {
    const out = toResponsesRequest({
      model: "gpt-5.6-luna",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "shot:" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              ],
            },
            { type: "text", text: "what is it?" },
          ],
        },
      ],
    })
    // function_call_output keeps string text with a placeholder,
    // images ride on the adjacent user item as input_image parts.
    expect(out.input[0]).toEqual({
      type: "function_call_output",
      call_id: "t1",
      output: "shot:\n\n[1 image(s) - attached to the next user message]",
    })
    expect(out.input[1]).toEqual({
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        { type: "input_text", text: "what is it?" },
      ],
    })
  })

  test(".done events rescue streams whose deltas were lost", () => {
    const adapter = new ResponsesEventAdapter()
    // Tool args: header arrives, delta is lost, .done carries the full JSON.
    adapter.pushEvent({
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "c1", id: "fc_1", name: "Read" },
    })
    const done = adapter.pushEvent({
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
      arguments: '{"file_path":"/x"}',
    })!
    expect(done.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments).toBe(
      '{"file_path":"/x"}',
    )
    // When deltas DID arrive, .done emits nothing (no duplication).
    const adapter2 = new ResponsesEventAdapter()
    adapter2.pushEvent({
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "c2", id: "fc_2", name: "Read" },
    })
    adapter2.pushEvent({
      type: "response.function_call_arguments.delta",
      item_id: "fc_2",
      delta: '{"file"',
    })
    expect(
      adapter2.pushEvent({
        type: "response.function_call_arguments.done",
        item_id: "fc_2",
        arguments: '{"file_path":"/x"}',
      }),
    ).toBeNull()
    // Text .done fallback when the delta never arrived.
    const adapter3 = new ResponsesEventAdapter()
    const textDone = adapter3.pushEvent({
      type: "response.output_text.done",
      item_id: "msg_1",
      text: "lost-and-found",
    })!
    expect(textDone.choices?.[0]?.delta?.content).toBe("lost-and-found")
  })

  test("completed usage maps cached_tokens into prompt_tokens_details", () => {
    const adapter = new ResponsesEventAdapter()
    const done = adapter.pushEvent({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 4 },
        },
      },
    })!
    expect(done.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 4 },
    })
  })

  test("responsesToOpenAIResponse flattens message and function_call output items", () => {
    const out = responsesToOpenAIResponse({
      id: "resp1",
      model: "gpt-5.6-luna",
      output: [
        { type: "message", content: [{ type: "output_text", text: "hi " }, { type: "output_text", text: "there" }] },
        { type: "function_call", call_id: "c9", name: "Bash", arguments: '{"cmd":"ls"}' },
      ],
      usage: { input_tokens: 4, output_tokens: 5 },
    })
    expect(out.choices?.[0]?.finish_reason).toBe("tool_calls")
    expect(out.choices?.[0]?.message?.content).toBe("hi there")
    expect(out.choices?.[0]?.message?.tool_calls).toEqual([
      { id: "c9", type: "function", function: { name: "Bash", arguments: '{"cmd":"ls"}' } },
    ])
    expect(out.usage).toEqual({ prompt_tokens: 4, completion_tokens: 5 })
  })

  test("keeps a non-streaming refusal visible", () => {
    const out = responsesToOpenAIResponse({
      id: "refused",
      model: "gpt-5.6-sol",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "I cannot help with that." }] }],
    })
    expect(out.choices?.[0]?.message?.content).toBe("I cannot help with that.")
  })
})

test("parallel Responses tool round-trips preserve ids, arguments and images", () => {
  const input = toResponsesRequest({
    model: "gpt", max_tokens: 32,
    messages: [
      { role: "assistant", content: [
        { type: "tool_use", id: "c1", name: "Read", input: { path: "/one" } },
        { type: "tool_use", id: "c2", name: "Read", input: { path: "/two" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "c1", content: [
          { type: "text", text: "one" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ] },
        { type: "tool_result", tool_use_id: "c2", content: "two" },
        { type: "text", text: "compare" },
      ] },
    ],
  }).input
  expect(input.slice(0, 4).map((item) => [item.type, item.call_id])).toEqual([
    ["function_call", "c1"], ["function_call", "c2"],
    ["function_call_output", "c1"], ["function_call_output", "c2"],
  ])
  expect(input[0].arguments).toBe('{"path":"/one"}')
  expect(input[1].arguments).toBe('{"path":"/two"}')
  expect(input[2].output).toContain("one")
  expect(input[3].output).toBe("two")
  expect(input[4]).toEqual({ role: "user", content: [
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    { type: "input_text", text: "compare" },
  ] })
})

test("Responses requests explicitly disable server-side storage", () => {
  const request = toResponsesRequest({ model: "gpt-5.6-luna", max_tokens: 32, messages: [] })
  expect(request.store).toBe(false)
  expect("max_output_tokens" in request).toBe(false)
})
