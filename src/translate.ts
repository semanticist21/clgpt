// Translation between the Anthropic Messages API (what Claude Code speaks)
// and the OpenAI-compatible ChatGPT Codex API.
//
// Content classification lives in blocks.ts; wire types in wire.ts;
// streaming response state lives in stream.ts.

import type {
  CacheControl,
  AnthropicMessage,
  AnthropicRequest,
  OpenAITextPart,
  OpenAIImagePart,
  OpenAIMessage,
  OpenAIRequest,
  OpenAIUsage,
  OpenAIChoice,
  OpenAIResponse,
  AnthropicContentBlock,
  AnthropicResponse,
} from "./wire"
import {
  type ImageBlock,
  type ToolResultBlock,
  type ToolUseBlock,
  classifyContent,
} from "./blocks"

function marked(blocks: unknown): boolean {
  return (
    Array.isArray(blocks) &&
    blocks.some(
      (b) => b && typeof b === "object" && (b as CacheControl).cache_control,
    )
  )
}

// Keep the cache marker internal to the translated message shape. The
// Responses path carries cache metadata through its own request format.
const PROMPT_CACHE = { type: "ephemeral" } as const

// The model catalog declares the reasoning_effort values each model accepts.
// Send the effort only when the model claims it —
// anything else is dropped rather than risking a 400.
export function effortFor(
  payload: AnthropicRequest,
  allowed: string[] | null | undefined,
): string | undefined {
  const effort = payload.output_config?.effort
  if (!effort || !allowed || !allowed.includes(effort)) return undefined
  return effort
}

// ---------------------------------------------------------------------------
// Request direction: Anthropic -> OpenAI
// ---------------------------------------------------------------------------

// Ids clgpt advertised to Claude Code, mapped back to the upstream slug they
// stand for. Populated from the live /models response after discovery, so the
// table always matches what the picker actually offered. Kept here rather
// than read from token.ts to avoid a cycle.
let modelAliases = new Map<string, string>()

export function setModelAliases(aliases: Map<string, string>): void {
  modelAliases = aliases
}

// Model aliases may be dot-form ("claude-sonnet-4.5"). Claude Code may echo back
// an advertised alias, dash-form, a date suffix, or a bracket suffix like
// [1m]; normalize all. The alias table wins over the pattern rules because it
// is derived from the upstream's own list — the patterns are only a fallback
// for ids discovery never saw (and they miss families like fable entirely).
export function normalizeModel(model: string): string {
  let m = model.replace(/\[[^\]]*\]$/, "")
  m = m.replace(/-\d{8}$/, "")
  const alias = modelAliases.get(m)
  if (alias) return alias
  m = m.replace(
    /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/,
    "claude-$1-$2.$3",
  )
  m = m.replace(/^claude-(\d+)-(\d+)-(sonnet|haiku|opus)$/, "claude-$1.$2-$3")
  return m
}

function debugWarn(message: string): void {
  if (process.env.CLGPT_DEBUG) console.error("[clgpt:debug]", message)
}

function toImagePart(block: ImageBlock): OpenAIImagePart {
  return {
    type: "image_url",
    image_url: {
      url: `data:${block.source.media_type};base64,${block.source.data}`,
    },
  }
}

// Tool messages must carry string content (OpenAI schema); images are moved
// into the adjacent user message instead, otherwise one image tool_result
// would poison every subsequent request in the session.
function toolResultText(result: ToolResultBlock): {
  text: string
  images: OpenAIImagePart[]
} {
  const images: OpenAIImagePart[] = []
  let text: string
  if (typeof result.content === "string") {
    text = result.content
  } else if (Array.isArray(result.content)) {
    const texts: string[] = []
    for (const view of classifyContent(result.content)) {
      if (view.kind === "text") texts.push(view.text)
      else if (view.kind === "image") images.push(toImagePart(view.block))
      // A tool_result nesting a tool_use or a document is not something the
      // protocol produces, but saying so beats dropping it.
      else if (view.kind === "unsupported") {
        texts.push(view.text)
        debugWarn(`tool_result carried a ${view.blockType} block`)
      }
    }
    text = texts.filter(Boolean).join("\n\n")
  } else {
    text = ""
  }
  if (result.is_error) text = `[error] ${text}`
  if (images.length > 0) {
    text =
      (text ? `${text}\n\n` : "") +
      `[${images.length} image(s) - attached to the next user message]`
  }
  return { text, images }
}

function translateUserMessage(message: AnthropicMessage): OpenAIMessage[] {
  if (typeof message.content === "string") {
    return [{ role: "user", content: message.content }]
  }
  const out: OpenAIMessage[] = []
  const toolResults = message.content.filter(
    (b): b is ToolResultBlock => b.type === "tool_result",
  )
  const rest = message.content.filter((b) => b.type !== "tool_result")

  // Protocol order: tool_use -> tool_result -> user.
  const images: OpenAIImagePart[] = []
  for (const result of toolResults) {
    const { text, images: resultImages } = toolResultText(result)
    images.push(...resultImages)
    out.push({ role: "tool", tool_call_id: result.tool_use_id, content: text })
  }

  const restTexts: string[] = []
  const restImages: OpenAIImagePart[] = []
  for (const view of classifyContent(rest)) {
    if (view.kind === "text") restTexts.push(view.text)
    else if (view.kind === "image") restImages.push(toImagePart(view.block))
    // Never silence. A PDF attachment used to translate to nothing at all, so
    // the model answered about a document it had never seen.
    else if (view.kind === "unsupported") {
      restTexts.push(view.text)
      debugWarn(`dropped a ${view.blockType} block from a user message`)
    }
  }

  if (images.length > 0 || restImages.length > 0) {
    const parts: Array<OpenAITextPart | OpenAIImagePart> = [
      ...images,
      ...restImages,
    ]
    const text = restTexts.join("\n\n")
    if (text) parts.push({ type: "text", text })
    out.push({ role: "user", content: parts })
  } else if (rest.length > 0) {
    out.push({ role: "user", content: restTexts.filter(Boolean).join("\n\n") })
  }
  return out
}

function translateAssistantMessage(message: AnthropicMessage): OpenAIMessage[] {
  if (typeof message.content === "string") {
    return [{ role: "assistant", content: message.content }]
  }
  const toolUses = message.content.filter(
    (b): b is ToolUseBlock => b.type === "tool_use",
  )
  // OpenAI has no thinking blocks; the classifier folds them into text (they
  // are usually empty here anyway because CLAUDE_CODE_DISABLE_THINKING is set).
  const text = classifyContent(message.content)
    .map((view) => {
      if (view.kind === "text") return view.text
      if (view.kind === "unsupported") {
        debugWarn(`dropped a ${view.blockType} block from an assistant message`)
        return view.text
      }
      return ""
    })
    .filter(Boolean)
    .join("\n\n")

  if (toolUses.length > 0) {
    return [
      {
        role: "assistant",
        content: text || null,
        tool_calls: toolUses.map((use) => ({
          id: use.id,
          type: "function" as const,
          function: {
            name: use.name,
            arguments: JSON.stringify(use.input),
          },
        })),
      },
    ]
  }
  return [{ role: "assistant", content: text }]
}

function translateSystem(
  system: AnthropicRequest["system"],
): OpenAIMessage[] {
  if (!system) return []
  const text =
    typeof system === "string"
      ? system
      : system.map((b) => b.text).join("\n\n")
  return [
    {
      role: "system",
      content: text,
      ...(marked(system) && { prompt_cache_control: PROMPT_CACHE }),
    },
  ]
}

function translateTools(
  tools: AnthropicRequest["tools"],
): OpenAIRequest["tools"] {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

function translateToolChoice(
  choice: AnthropicRequest["tool_choice"],
): OpenAIRequest["tool_choice"] {
  if (!choice) return undefined
  switch (choice.type) {
    case "auto":
      return "auto"
    case "any":
      return "required"
    case "none":
      return "none"
    case "tool":
      return choice.name
        ? { type: "function", function: { name: choice.name } }
        : undefined
    default:
      return undefined
  }
}

export function translateRequest(
  payload: AnthropicRequest,
  allowedEfforts?: string[] | null,
): OpenAIRequest {
  const effort = effortFor(payload, allowedEfforts)
  return {
    model: normalizeModel(payload.model),
    ...(effort && { reasoning_effort: effort }),
    messages: [
      ...translateSystem(payload.system),
      ...payload.messages.flatMap((message) => {
        const out =
          message.role === "user"
            ? translateUserMessage(message)
            : translateAssistantMessage(message)
        // Carry a cache breakpoint onto the last message this turn produced.
        const last = out[out.length - 1]
        if (last && marked(message.content)) {
          last.prompt_cache_control = PROMPT_CACHE
        }
        return out
      }),
    ],
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences?.length ? payload.stop_sequences : null,
    stream: payload.stream,
    stream_options: payload.stream ? { include_usage: true } : undefined,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id ?? null,
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
  }
}

// ---------------------------------------------------------------------------
// Response direction: OpenAI -> Anthropic (non-streaming)
// ---------------------------------------------------------------------------

export function mapStopReason(
  finish: OpenAIChoice["finish_reason"],
): AnthropicResponse["stop_reason"] {
  if (finish === null) return null
  switch (finish) {
    case "stop":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "tool_calls":
      return "tool_use"
    case "content_filter":
      return "end_turn"
  }
}

export function usageFromOpenAI(usage: OpenAIUsage | undefined) {
  const cached = usage?.prompt_tokens_details?.cached_tokens
  return {
    input_tokens: Math.max(
      0,
      (usage?.prompt_tokens ?? 0) - (cached ?? 0),
    ),
    output_tokens: usage?.completion_tokens ?? 0,
    ...(cached !== undefined && { cache_read_input_tokens: cached }),
  }
}

export function translateResponse(upstream: OpenAIResponse): AnthropicResponse {
  const choice = upstream.choices?.[0]
  const content: AnthropicContentBlock[] = []

  const messageContent = choice?.message?.content
  if (typeof messageContent === "string" && messageContent.length > 0) {
    content.push({ type: "text", text: messageContent })
  } else if (Array.isArray(messageContent)) {
    for (const part of messageContent) {
      if (part.type === "text") content.push({ type: "text", text: part.text })
    }
  }
  for (const call of choice?.message?.tool_calls ?? []) {
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(call.function.arguments || "{}") as Record<
        string,
        unknown
      >
    } catch {
      // Malformed arguments: fall back to empty input rather than failing.
    }
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input,
    })
  }
  if (content.length === 0) content.push({ type: "text", text: "" })

  let stopReason = mapStopReason(choice?.finish_reason ?? null)
  // "tool_use" with no tool_use block is not a valid Anthropic response.
  if (stopReason === "tool_use" && !content.some((b) => b.type === "tool_use")) {
    stopReason = "end_turn"
  }

  return {
    id: upstream.id,
    type: "message",
    role: "assistant",
    model: upstream.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usageFromOpenAI(upstream.usage),
  }
}
