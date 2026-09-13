// Wire shapes shared by the request and response dialects.
import type { ContentBlock, ToolUseBlock } from "./blocks"

export interface CacheControl {
  cache_control?: { type?: string } | null
}

export interface AnthropicTextBlock extends CacheControl {
  type: "text"
  text: string
}

export interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | ContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export interface AnthropicRequest {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: string | Array<AnthropicTextBlock>
  tools?: AnthropicTool[]
  tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string }
  stream?: boolean
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  metadata?: { user_id?: string }
  thinking?: unknown
  /** Claude Code's /effort setting rides here (gateway protocol). */
  output_config?: { effort?: string }
}

export interface OpenAITextPart {
  type: "text"
  text: string
}

export interface OpenAIImagePart {
  type: "image_url"
  image_url: { url: string }
}

export type OpenAIContent = string | Array<OpenAITextPart | OpenAIImagePart> | null

export interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: OpenAIContent
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  prompt_cache_control?: { type: "ephemeral" }
}

export interface OpenAIRequest {
  model: string
  messages: OpenAIMessage[]
  max_tokens?: number
  stop?: string[] | null
  stream?: boolean
  stream_options?: { include_usage: boolean }
  reasoning_effort?: string
  temperature?: number
  top_p?: number
  user?: string | null
  tools?: Array<{
    type: "function"
    function: {
      name: string
      description?: string
      parameters: Record<string, unknown>
    }
  }> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
}

export interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export interface OpenAIChoice {
  index: number
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  message?: { role: "assistant"; content: OpenAIContent; tool_calls?: OpenAIToolCall[] }
  delta?: {
    role?: string
    content?: string | null
    tool_calls?: Array<{
      index: number
      id?: string
      function?: { name?: string; arguments?: string }
    }>
  }
}

export interface OpenAIResponse {
  id: string
  model: string
  choices?: OpenAIChoice[]
  usage?: OpenAIUsage
  error?: { message?: string; code?: string | number }
}

// ---------------------------------------------------------------------------
// Anthropic response types
// ---------------------------------------------------------------------------

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | ToolUseBlock

export interface AnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  model: string
  content: AnthropicContentBlock[]
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | null
  stop_sequence: null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
  }
}

export interface StreamEventData {
  event: string
  data: Record<string, unknown>
}
