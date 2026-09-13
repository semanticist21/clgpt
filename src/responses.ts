// ChatGPT Codex serves newer models (GPT-5.x "luna" family, codex) through
// the OpenAI Responses API (POST /responses) instead of /chat/completions.
// This module translates Anthropic requests into Responses requests, and
// Responses SSE events into OpenAI-style chunks so the existing
// StreamTranslator can render Anthropic events unchanged.

import { effortFor, normalizeModel } from "./translate"
import type { AnthropicRequest, OpenAIResponse } from "./wire"
import { classifyContent } from "./blocks"

// ---------------------------------------------------------------------------
// Request direction: Anthropic -> Responses
// ---------------------------------------------------------------------------

interface ResponsesTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict?: false
}

interface ResponsesRequest {
  model: string
  instructions?: string
  input: Array<Record<string, unknown>>
  /** ChatGPT Codex rejects requests that omit this privacy setting. */
  store: false
  stream?: boolean
  temperature?: number
  top_p?: number
  tools?: ResponsesTool[]
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string }
  reasoning?: { effort: string }
  service_tier?: "fast"
}

export function toResponsesRequest(
  payload: AnthropicRequest,
  allowedEfforts?: string[] | null,
): ResponsesRequest {
  const input: Array<Record<string, unknown>> = []

  for (const message of payload.messages) {
    if (typeof message.content === "string") {
      input.push({
        role: message.role,
        content: [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: message.content,
          },
        ],
      })
      continue
    }

    // Tool results must land in the same order as the conversation.
    const rest: Array<Record<string, unknown>> = []
    const pendingImages: Array<Record<string, unknown>> = []
    for (const view of classifyContent(message.content)) {
      if (view.kind === "tool_result") {
        const block = view.block
        // Flush pending user content before the tool output to preserve
        // ordering (results come first in Anthropic user messages anyway).
        if (rest.length > 0) {
          input.push({ role: "user", content: [...rest] })
          rest.length = 0
        }
        let text: string
        const images: Array<Record<string, unknown>> = []
        if (typeof block.content === "string") {
          text = block.content
        } else if (Array.isArray(block.content)) {
          const texts: string[] = []
          for (const child of classifyContent(block.content)) {
            if (child.kind === "text" || child.kind === "unsupported") texts.push(child.text)
            else if (child.kind === "image")
              images.push({
                type: "input_image",
                image_url: `data:${child.block.source.media_type};base64,${child.block.source.data}`,
              })
          }
          text = texts.join("\n\n")
        } else {
          text = ""
        }
        if (block.is_error) text = `[error] ${text}`
        if (images.length > 0) {
          text =
            (text ? `${text}\n\n` : "") +
            `[${images.length} image(s) - attached to the next user message]`
          pendingImages.push(...images)
        }
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: text,
        })
        continue
      }
      if (view.kind === "text" || view.kind === "unsupported") {
        rest.push({
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: view.text,
        })
      } else if (view.kind === "image") {
        const block = view.block
        rest.push({
          type: "input_image",
          image_url: `data:${block.source.media_type};base64,${block.source.data}`,
        })
      } else if (view.kind === "tool_use") {
        const block = view.block
        if (rest.length > 0) {
          input.push({ role: message.role, content: [...rest] })
          rest.length = 0
        }
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        })
      } else {
        const exhaustive: never = view
        throw new Error(`unhandled content: ${exhaustive}`)
      }
    }
    if (pendingImages.length > 0 || rest.length > 0) {
      // Merge pending tool-result images with trailing text into ONE user
      // message (mirrors the chat dialect's adjacent-user-message layout).
      input.push({
        role: message.role,
        content: [...pendingImages, ...rest],
      })
      pendingImages.length = 0
    }
  }

  const instructions = Array.isArray(payload.system)
    ? payload.system.map((b) => b.text).join("\n\n")
    : payload.system

  const effort = effortFor(payload, allowedEfforts)

  return {
    model: normalizeModel(payload.model),
    ...(instructions && { instructions }),
    ...(effort && { reasoning: { effort } }),
    input,
    store: false,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    // Claude's built-in server-side tools (WebSearch, WebFetch) arrive
    // without input_schema and cannot be executed by an upstream that only
    // knows function tools - drop them rather than sending a broken schema.
    tools: payload.tools?.filter((t) => t.input_schema).map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
      strict: false as const,
    })),
    tool_choice:
      payload.tool_choice?.type === "auto"
        ? "auto"
        : payload.tool_choice?.type === "none"
          ? "none"
          : payload.tool_choice?.type === "any"
            ? "required"
            : payload.tool_choice?.name
              ? { type: "function", name: payload.tool_choice.name }
              : undefined,
    ...(payload.speed === "fast" ? { service_tier: "fast" as const } : {}),
  }
}

// ---------------------------------------------------------------------------
// Event direction: Responses SSE -> OpenAI-style chunks (for StreamTranslator)
// ---------------------------------------------------------------------------

function incompleteError(response: Record<string, unknown> | undefined): OpenAIResponse | null {
  const details = response?.incomplete_details as { reason?: string } | undefined
  const reason = details?.reason
  // Only token exhaustion (or missing detail) maps to max_tokens. Other
  // incomplete causes must not masquerade as successful text or tool calls.
  if (!reason || reason === "max_output_tokens" || reason === "max_tokens") return null
  return { id: "r", model: "", error: { code: "response_incomplete", message: `upstream response incomplete: ${reason}` } }
}

export class ResponsesEventAdapter {
  private toolIndexes = new Map<string, number>()
  private argsAccum = new Map<string, string>()
  private textAccum = new Map<string, string>()
  private refusalAccum = ""
  private nextIndex = 0
  private sawToolCall = false

  /** Convert one Responses stream event into OpenAI-chunk shape (or null). */
  pushEvent(event: Record<string, unknown>): OpenAIResponse | null {
    const type = event.type as string | undefined
    if (!type) return null

    if (type === "response.output_text.delta") {
      const delta = event.delta as string | undefined
      if (!delta) return null
      const key = String(event.item_id ?? "r")
      this.textAccum.set(key, (this.textAccum.get(key) ?? "") + delta)
      return {
        id: key,
        model: "",
        choices: [{ index: 0, finish_reason: null, delta: { content: delta } }],
      }
    }

    if (type === "response.output_text.done") {
      // Authoritative fallback: if no delta arrived for this item, emit the
      // full text so a lost stream cannot silently become an empty message.
      const key = String(event.item_id ?? "r")
      const full = (event.text as string | undefined) ?? ""
      if (full && !(this.textAccum.get(key) ?? "")) {
        return {
          id: key,
          model: "",
          choices: [{ index: 0, finish_reason: null, delta: { content: full } }],
        }
      }
      return null
    }

    if (type === "response.refusal.delta") {
      const delta = event.delta as string | undefined
      if (!delta) return null
      this.refusalAccum += delta
      return {
        id: "refusal",
        model: "",
        choices: [{ index: 0, finish_reason: null, delta: { content: delta } }],
      }
    }

    if (type === "response.refusal.done") {
      const full = (event.refusal as string | undefined) ?? ""
      if (full && !this.refusalAccum) {
        this.refusalAccum = full
        return {
          id: "refusal",
          model: "",
          choices: [{ index: 0, finish_reason: null, delta: { content: full } }],
        }
      }
      return null
    }

    if (type === "response.output_item.added") {
      const item = event.item as
        | { type?: string; call_id?: string; id?: string; name?: string }
        | undefined
      if (item?.type !== "function_call") return null
      this.sawToolCall = true
      const index = this.nextIndex++
      const key = String(item.call_id ?? item.id ?? index)
      this.toolIndexes.set(key, index)
      // Arguments deltas are keyed by item_id; remember that too.
      if (item.id) this.toolIndexes.set(String(item.id), index)
      return {
        id: String(item.call_id ?? item.id ?? "r"),
        model: "",
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              tool_calls: [
                {
                  index,
                  id: item.call_id ?? item.id,
                  function: { name: item.name ?? "", arguments: "" },
                },
              ],
            },
          },
        ],
      }
    }

    if (type === "response.function_call_arguments.delta") {
      const delta = event.delta as string | undefined
      if (!delta) return null
      const key = String(event.item_id ?? "")
      const index = this.toolIndexes.get(key)
      if (index === undefined) return null
      this.argsAccum.set(key, (this.argsAccum.get(key) ?? "") + delta)
      return {
        id: key,
        model: "",
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              tool_calls: [{ index, function: { arguments: delta } }],
            },
          },
        ],
      }
    }

    if (type === "response.function_call_arguments.done") {
      const key = String(event.item_id ?? "")
      const index = this.toolIndexes.get(key)
      if (index === undefined) return null
      const full = (event.arguments as string | undefined) ?? ""
      if (full && !(this.argsAccum.get(key) ?? "")) {
        return {
          id: key,
          model: "",
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: {
                tool_calls: [{ index, function: { arguments: full } }],
              },
            },
          ],
        }
      }
      return null
    }

    if (type === "response.completed" || type === "response.incomplete") {
      if (type === "response.incomplete") {
        const error = incompleteError(event.response as Record<string, unknown> | undefined)
        if (error) return error
      }
      const response = event.response as
        | {
            usage?: {
              input_tokens?: number
              output_tokens?: number
              input_tokens_details?: { cached_tokens?: number }
            }
          }
        | undefined
      const usage = response?.usage
      const cached = usage?.input_tokens_details?.cached_tokens
      return {
        id: "r",
        model: "",
        choices: [
          {
            index: 0,
            finish_reason: type === "response.incomplete" ? "length" : this.sawToolCall ? "tool_calls" : "stop",
            delta: {},
          },
        ],
        usage: usage
          ? {
              prompt_tokens: usage.input_tokens,
              completion_tokens: usage.output_tokens,
              ...(cached !== undefined && {
                prompt_tokens_details: { cached_tokens: cached },
              }),
            }
          : undefined,
      }
    }

    if (type === "response.failed") {
      const response = event.response as
        | { error?: { message?: string; code?: string } }
        | undefined
      return {
        id: "r",
        model: "",
        error: {
          message: response?.error?.message ?? "upstream response failed",
          code: response?.error?.code,
        },
      } as OpenAIResponse
    }

    if (type === "error") {
      return {
        id: "r",
        model: "",
        error: {
          message: (event.message as string | undefined) ?? "upstream stream error",
        },
      } as OpenAIResponse
    }

    return null
  }
}

// ---------------------------------------------------------------------------
// Non-streaming: Responses response JSON -> OpenAI response shape
// ---------------------------------------------------------------------------

export function responsesToOpenAIResponse(
  body: Record<string, unknown>,
): OpenAIResponse {
  if (body.status === "incomplete") {
    const error = incompleteError(body)
    if (error) return error
  }
  const output = (body.output as Array<Record<string, unknown>> | undefined) ?? []
  let text = ""
  const toolCalls: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> = []
  for (const item of output) {
    if (item.type === "message") {
      const content = (item.content as Array<{ type?: string; text?: string; refusal?: string }> | undefined) ?? []
      for (const part of content) {
        if (part.type === "output_text") text += part.text ?? ""
        if (part.type === "refusal") text += part.refusal ?? part.text ?? ""
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: String(item.call_id ?? item.id ?? ""),
        type: "function",
        function: {
          name: String(item.name ?? ""),
          arguments: String(item.arguments ?? "{}"),
        },
      })
    }
  }
  const usage = body.usage as
    | {
        input_tokens?: number
        output_tokens?: number
        input_tokens_details?: { cached_tokens?: number }
      }
    | undefined
  return {
    id: String(body.id ?? "r"),
    model: String(body.model ?? ""),
    choices: [
      {
        index: 0,
        finish_reason: body.status === "incomplete" ? "length" : toolCalls.length > 0 ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.input_tokens,
          completion_tokens: usage.output_tokens,
          ...(usage.input_tokens_details?.cached_tokens !== undefined && {
            prompt_tokens_details: {
              cached_tokens: usage.input_tokens_details.cached_tokens,
            },
          }),
        }
      : undefined,
  }
}
