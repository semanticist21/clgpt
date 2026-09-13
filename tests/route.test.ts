import { describe, expect, test } from "bun:test"
import { DialectRouter, nativeModelRejected } from "../src/route"
import { normalizeModel } from "../src/translate"
import type { UpstreamModel } from "../src/token"

const model: UpstreamModel = { id: "claude-sonnet-4.5", name: "Claude", endpoints: ["/v1/messages", "/chat/completions"], efforts: null }

describe("native rejection evidence", () => {
  test.each([
    [400, "unsupported parameter: temperature", false],
    [400, "model rejected by moderation", false],
    [400, "model 'x' has an unsupported parameter", false],
    [400, "model is not supported for this temperature", false],
    [422, "request temporarily unavailable", false],
    [400, "The requested model is not available", false],
    [415, "unsupported media type", false],
    [400, "The requested model is not supported", true],
    [400, "model gpt-test is not supported", true],
    [400, 'model "x" is not accessible via this endpoint', true],
    [404, "not found", true],
    [422, '{"error":{"code":"model_not_supported","message":"unsupported"}}', true],
    [415, '{"error":{"code":"endpoint_not_supported"}}', true],
    [401, "model not supported", false],
    [403, "model not supported", false],
    [429, "model not supported", false],
    [500, "model not supported", false],
  ] as const)("status=%i, %s -> learned=%s", (status, body, expected) => {
    expect(nativeModelRejected(status, body)).toBe(expected)
  })
})

describe("dialect memory", () => {
  test("request errors do not change future native selection", () => {
    const routes = new DialectRouter()
    expect(routes.select(model.id, model, true)).toBe("native")
    expect(routes.rejectNative(model.id, 400, "unsupported parameter")).toBe(false)
    expect(routes.select(model.id, model, true)).toBe("native")
  })

  test("a model rejection uses the same normalized key for future requests", () => {
    const routes = new DialectRouter()
    expect(routes.rejectNative(normalizeModel("claude-sonnet-4-5[1m]"), 404, "not found")).toBe(true)
    expect(routes.select(model.id, model, true)).toBe("chat")
    expect(routes.rejectNative(model.id, 404, "not found")).toBe(false)
    expect(routes.select("another", { ...model, id: "another" }, true)).toBe("native")
  })

  test("Responses discovery and learned fallback survive native demotion", () => {
    const routes = new DialectRouter()
    const both = { ...model, endpoints: ["/v1/messages", "/responses"] }
    expect(routes.select(model.id, both, true)).toBe("native")
    expect(routes.select(model.id, both, false)).toBe("responses")
    routes.rejectNative(model.id, 404, "not found")
    expect(routes.select(model.id, both, true)).toBe("responses")
    routes.requireResponses(normalizeModel("m[1m]"))
    expect(routes.select("m", undefined, false)).toBe("responses")
    expect(routes.select("unknown", undefined, true)).toBe("chat")
  })
})

test("upstream ids are not normalized twice or conflated", () => {
  const routes = new DialectRouter()
  routes.rejectNative("model-20250101", 404, "not found")
  expect(routes.select("model-20250101", model, true)).toBe("chat")
  expect(routes.select("model-20250201", model, true)).toBe("native")
  routes.requireResponses("model-20250101")
  expect(routes.translated("model-20250101", undefined)).toBe("responses")
  expect(routes.translated("model-20250201", undefined)).toBe("chat")
})
