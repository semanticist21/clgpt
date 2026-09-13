// The one place that decides what an Anthropic content block means.
//
// It used to be twenty `block.type === "..."` comparisons spread across
// translate.ts and responses.ts, each an if/else-if chain with no final else.
// A block type none of them listed therefore contributed nothing and said
// nothing: a PDF attachment (`document`) was dropped on the floor and the
// model answered confidently about a file it had never seen. Nothing in the
// type system could catch that, because every block arrives through
// `JSON.parse` and Claude Code adds block types on its own schedule.
//
// So the knowledge lives here, once, and the dispatch is exhaustive: adding a
// type to KNOWN_BLOCKS without handling it fails `tsc`, and anything NOT in
// KNOWN_BLOCKS becomes a visible placeholder rather than silence. The dialects
// then only decide how to render a classified block, never what one is.

export interface TextBlock {
  type: "text"
  text: string
  /** ChatGPT's prompt-cache marker rides on the block Claude Code sends. */
  cache_control?: { type: string }
}

export interface ThinkingBlock {
  type: "thinking"
  thinking: string
}

/** Thinking the upstream redacted; it carries no readable text. */
export interface RedactedThinkingBlock {
  type: "redacted_thinking"
  data: string
}

export interface ImageBlock {
  type: "image"
  source: { type: string; media_type: string; data: string }
}

/** A file attachment. No translated dialect has anywhere to put one. */
export interface DocumentBlock {
  type: "document"
  source: { type: string; media_type?: string; data?: string; url?: string }
  title?: string
}

export interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  is_error?: boolean
  content?: string | Array<TextBlock | ImageBlock | ThinkingBlock>
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ImageBlock
  | DocumentBlock
  | ToolUseBlock
  | ToolResultBlock

/**
 * Every type this file knows how to classify. The exhaustive switch below is
 * checked against it, so extending this list without extending the switch is
 * a compile error - which is the whole point of the file.
 */
export const KNOWN_BLOCKS = [
  "text",
  "thinking",
  "redacted_thinking",
  "image",
  "document",
  "tool_use",
  "tool_result",
] as const

export type KnownBlockType = (typeof KNOWN_BLOCKS)[number]

const KNOWN = new Set<string>(KNOWN_BLOCKS)

/**
 * A block as it arrives: off the wire via JSON.parse, so nothing about it is
 * guaranteed. Taking `unknown` rather than a shaped type is deliberate - the
 * whole failure this file fixes was code that trusted a shape the wire never
 * promised.
 */
export type RawBlock = unknown

function field(block: unknown, key: string): unknown {
  return typeof block === "object" && block !== null
    ? (block as Record<string, unknown>)[key]
    : undefined
}

/** What a dialect has to render. `unsupported` is never silence. */
export type Classified =
  | { kind: "text"; text: string }
  | { kind: "image"; block: ImageBlock }
  | { kind: "tool_use"; block: ToolUseBlock }
  | { kind: "tool_result"; block: ToolResultBlock }
  /**
   * Carried forward as text so the model is told something was there. A
   * dropped block changes the answer; a named placeholder only shortens it,
   * and the user can see which it was.
   */
  | { kind: "unsupported"; blockType: string; text: string }

/** Wire strings are not guaranteed to be strings. */
function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function assertNever(value: never): never {
  throw new Error(`unhandled content block: ${JSON.stringify(value)}`)
}

function placeholder(blockType: string, detail?: string): Classified {
  return {
    kind: "unsupported",
    blockType,
    text: `[clgpt: a ${blockType} block was not forwarded - this model's dialect has no equivalent${
      detail ? `, ${detail}` : ""
    }]`,
  }
}

/**
 * Classify one block. Unknown types and known-but-unforwardable types both
 * come back as `unsupported`, distinguishable by `blockType`.
 */
export function classifyBlock(block: RawBlock): Classified {
  const raw = field(block, "type")
  const type = typeof raw === "string" ? raw : "(missing type)"
  if (!KNOWN.has(type)) return placeholder(type)
  return classifyKnown(block, type as KnownBlockType)
}

// `block` stays raw here rather than being asserted to ContentBlock: it came
// off the wire, so a field the interface calls required may simply be absent,
// and each case narrows only what it actually reads.
function classifyKnown(block: unknown, type: KnownBlockType): Classified {
  switch (type) {
    case "text":
      return { kind: "text", text: str(field(block, "text")) }
    // Reasoning text is ordinary text to a dialect that has no thinking
    // channel; dropping it loses the assistant's own stated reasoning from
    // the transcript it is about to continue.
    case "thinking":
      return { kind: "text", text: str(field(block, "thinking")) }
    // Nothing readable to forward, and it is not a loss worth narrating on
    // every turn - the upstream redacted it, not clgpt.
    case "redacted_thinking":
      return { kind: "text", text: "" }
    case "image":
      return { kind: "image", block: block as unknown as ImageBlock }
    case "document": {
      const title = str(field(block, "title"))
      return placeholder(
        "document",
        title ? `titled ${JSON.stringify(title)}` : "no text extracted",
      )
    }
    case "tool_use":
      return { kind: "tool_use", block: block as unknown as ToolUseBlock }
    case "tool_result":
      return { kind: "tool_result", block: block as unknown as ToolResultBlock }
    default:
      return assertNever(type)
  }
}

/** Classify a whole message body, with the string shorthand expanded. */
export function classifyContent(content: unknown): Classified[] {
  if (content === undefined || content === null) return []
  if (typeof content === "string") return [{ kind: "text", text: content }]
  if (!Array.isArray(content)) return []
  return content.map(classifyBlock)
}

/** The block types in a body that clgpt could not forward, for diagnostics. */
export function unsupportedTypes(blocks: Classified[]): string[] {
  return [
    ...new Set(
      blocks
        .filter((b): b is Extract<Classified, { kind: "unsupported" }> =>
          b.kind === "unsupported",
        )
        .map((b) => b.blockType),
    ),
  ]
}
