import { describe, expect, test } from "bun:test"
import { estimateTokens, fallbackInputWindow } from "../src/tokens"
import type { AnthropicRequest } from "../src/wire"

const request = (content: AnthropicRequest["messages"][number]["content"]): AnthropicRequest => ({
  model: "m", max_tokens: 1, messages: [{ role: "user", content }],
})

describe("token estimate content accounting", () => {
  test("splitting text into blocks does not charge for wire envelopes", () => {
    const text = "hello world ".repeat(400)
    expect(estimateTokens(request(Array.from({ length: 400 }, () => ({ type: "text", text: "hello world " })))))
      .toBe(estimateTokens(request(text)))
  })

  test("ordinary tool input named data is counted as text, not an image", () => {
    const withData = (data: string) => estimateTokens(request([
      { type: "tool_use", id: "t", name: "Write", input: { data } },
    ]))
    expect(withData("x".repeat(35000)) - withData("x".repeat(3500))).toBeGreaterThan(8000)
  })

  test("tool ids are transport metadata but arguments and schemas are content", () => {
    const tool = { type: "tool_use" as const, id: "short", name: "Write", input: { text: "hi" } }
    expect(estimateTokens(request([tool])))
      .toBe(estimateTokens(request([{ ...tool, id: "x".repeat(10000) }])))
    const base = request("hi")
    expect(estimateTokens({ ...base, tools: [{ name: "Write", input_schema: { description: "x".repeat(3500) } }] }))
      .toBeGreaterThan(estimateTokens(base) + 900)
  })
})

describe("estimateTokens", () => {
  test("scales with content size", () => {
    const small = estimateTokens({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })
    const large = estimateTokens({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "x".repeat(3500) }],
    })
    expect(small).toBeGreaterThan(0)
    expect(large).toBeGreaterThan(small * 10)
  })
})

describe("estimateTokens", () => {
  const wrap = (content: unknown) =>
    ({
      model: "m",
      max_tokens: 16,
      messages: [{ role: "user", content }],
    }) as Parameters<typeof estimateTokens>[0]

  // Image token cost depends on the model and dimensions, not base64 length.
  // This estimator uses a fixed approximation, never a measured token count.
  test("uses an image approximation independent of its base64 length", () => {
    const withImage = estimateTokens(
      wrap([
        { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(1_400_000) } },
        { type: "text", text: "look at this" },
      ]),
    )
    expect(withImage).toBeLessThan(5_000)
    // Still counted, just not by the byte.
    expect(withImage).toBeGreaterThan(estimateTokens(wrap([{ type: "text", text: "look at this" }])))
  })

  test("still scales with actual text", () => {
    const small = estimateTokens(wrap("hi"))
    const large = estimateTokens(wrap("x".repeat(70_000)))
    expect(large).toBeGreaterThan(small * 100)
  })
})

describe("unknown model input budget", () => {
  test("caps the fallback and honors smaller discovered windows", () => {
    expect(fallbackInputWindow([])).toBe(128000)
    expect(fallbackInputWindow([200000, 1000000])).toBe(128000)
    expect(fallbackInputWindow([64000, 128000, 200000])).toBe(64000)
    expect(fallbackInputWindow([undefined, 0, -1, NaN, Infinity])).toBe(128000)
  })
})
