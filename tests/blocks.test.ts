import { describe, expect, test } from "bun:test"
import {
  KNOWN_BLOCKS,
  classifyBlock,
  classifyContent,
  unsupportedTypes,
} from "../src/blocks"

describe("classifyBlock", () => {
  test("text and thinking both read as text", () => {
    expect(classifyBlock({ type: "text", text: "hi" })).toEqual({
      kind: "text",
      text: "hi",
    })
    // A dialect with no thinking channel still needs the assistant's own
    // stated reasoning in the transcript it is about to continue.
    expect(classifyBlock({ type: "thinking", thinking: "hmm" })).toEqual({
      kind: "text",
      text: "hmm",
    })
  })

  test("images, tool_use and tool_result are passed through for rendering", () => {
    expect(classifyBlock({ type: "image", source: {} }).kind).toBe("image")
    expect(classifyBlock({ type: "tool_use", id: "t1" }).kind).toBe("tool_use")
    expect(classifyBlock({ type: "tool_result", tool_use_id: "t1" }).kind).toBe(
      "tool_result",
    )
  })

  // The defect this file exists for: a PDF attachment used to translate to
  // nothing at all, so the model answered about a document it never saw.
  test("a document becomes a visible placeholder, never silence", () => {
    const doc = classifyBlock({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBER" },
      title: "spec.pdf",
    })
    expect(doc.kind).toBe("unsupported")
    expect(doc.kind === "unsupported" && doc.blockType).toBe("document")
    expect(doc.kind === "unsupported" && doc.text).toContain("document")
    expect(doc.kind === "unsupported" && doc.text).toContain("spec.pdf")
  })

  // Claude Code adds block types on its own schedule, and every block reaches
  // clgpt through JSON.parse, so the type system cannot see the new one.
  test("a block type clgpt has never heard of is named, not dropped", () => {
    const next = classifyBlock({ type: "server_tool_use", id: "x" })
    expect(next.kind).toBe("unsupported")
    expect(next.kind === "unsupported" && next.blockType).toBe("server_tool_use")
    expect(next.kind === "unsupported" && next.text).toContain("server_tool_use")
  })

  test("a block with no type at all is still reported", () => {
    const junk = classifyBlock({})
    expect(junk.kind).toBe("unsupported")
    expect(junk.kind === "unsupported" && junk.blockType).toBe("(missing type)")
  })

  // Guards the compile-time guarantee: the switch is checked against this
  // list, so a name added here without a case fails tsc. If this ever fails,
  // someone extended the list and the classifier has a hole again.
  test("every declared known type classifies without hitting the fallback", () => {
    const sample: Record<string, Record<string, unknown>> = {
      text: { text: "" },
      thinking: { thinking: "" },
      redacted_thinking: { data: "" },
      image: { source: {} },
      document: { source: {} },
      tool_use: { id: "", name: "", input: {} },
      tool_result: { tool_use_id: "" },
    }
    for (const type of KNOWN_BLOCKS) {
      const result = classifyBlock({ type, ...sample[type] })
      // document is known AND unforwardable, which is a different thing from
      // unrecognised - it names itself rather than falling through.
      if (type === "document") {
        expect(result.kind).toBe("unsupported")
        expect(result.kind === "unsupported" && result.blockType).toBe("document")
      } else {
        expect(result.kind).not.toBe("unsupported")
      }
    }
  })
})

describe("classifyContent", () => {
  test("the string shorthand is one text block", () => {
    expect(classifyContent("plain")).toEqual([{ kind: "text", text: "plain" }])
  })

  test("missing or malformed content is empty, not a throw", () => {
    expect(classifyContent(undefined)).toEqual([])
    expect(classifyContent({} as never)).toEqual([])
  })

  test("unsupportedTypes names each kind once", () => {
    const blocks = classifyContent([
      { type: "text", text: "a" },
      { type: "document", source: {} },
      { type: "document", source: {} },
      { type: "search_result" },
    ])
    expect(unsupportedTypes(blocks)).toEqual(["document", "search_result"])
  })
})
