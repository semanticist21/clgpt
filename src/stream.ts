// OpenAI chunks -> Anthropic SSE, shared by chat and Responses routes.
import type { OpenAIChoice, OpenAIUsage, OpenAIResponse, StreamEventData } from "./wire"
import { mapStopReason, usageFromOpenAI } from "./translate"

function debugWarn(message: string): void {
  if (process.env.CLGPT_DEBUG) console.error("[clgpt:debug]", message)
}

interface ToolTrack {
  anthropicIndex: number
  id: string
  name: string
  bufferedArgs: string
  started: boolean
  open: boolean
}

export class StreamTranslator {
  private messageStartSent = false
  private textOpen = false
  private textIndex = -1
  private nextIndex = 0
  private toolCalls = new Map<number, ToolTrack>()
  private anyToolStarted = false
  private latestUsage: OpenAIUsage | undefined
  private lastFinishReason: OpenAIChoice["finish_reason"] = null
  private finished = false

  constructor(private model: string) {}

  pushChunk(chunk: OpenAIResponse): StreamEventData[] {
    // Nothing may be emitted after the message closed.
    if (this.finished) return []
    const events: StreamEventData[] = []
    // Usage may arrive in a dedicated terminal chunk with empty choices
    // (stream_options include_usage convention); track it from any chunk.
    if (chunk.usage) this.latestUsage = chunk.usage
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    const choice = choices[0]
    if (!choice) return events
    const delta = choice.delta

    if (!this.messageStartSent) {
      events.push(this.messageStart(chunk.model || this.model))
    }

    if (delta?.content) {
      // Tool blocks must all close before a text block starts (Anthropic
      // blocks are strictly sequential).
      this.closeOpenTools(events)
      if (!this.textOpen) {
        this.textIndex = this.nextIndex++
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: this.textIndex,
            content_block: { type: "text", text: "" },
          },
        })
        this.textOpen = true
      }
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.textIndex,
          delta: { type: "text_delta", text: delta.content },
        },
      })
    }

    if (delta?.tool_calls) {
      for (const call of delta.tool_calls) {
        let track = this.toolCalls.get(call.index)
        if (!track) {
          track = {
            anthropicIndex: -1,
            id: "",
            name: "",
            bufferedArgs: "",
            started: false,
            open: false,
          }
          this.toolCalls.set(call.index, track)
        }
        // id and name may arrive in separate fragments; only start the block
        // once both are known.
        if (call.id) track.id = call.id
        if (call.function?.name) track.name = call.function.name
        if (!track.started && track.id && track.name) {
          if (this.textOpen) {
            events.push({
              event: "content_block_stop",
              data: { type: "content_block_stop", index: this.textIndex },
            })
            this.textOpen = false
          }
          track.anthropicIndex = this.nextIndex++
          track.started = true
          track.open = true
          this.anyToolStarted = true
          events.push({
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: track.anthropicIndex,
              content_block: {
                type: "tool_use",
                id: track.id,
                name: track.name,
                input: {},
              },
            },
          })
          if (track.bufferedArgs) {
            events.push(this.jsonDelta(track.anthropicIndex, track.bufferedArgs))
            track.bufferedArgs = ""
          }
        }
        if (call.function?.arguments) {
          if (track.started && track.open) {
            events.push(this.jsonDelta(track.anthropicIndex, call.function.arguments))
          } else if (track.started) {
            debugWarn(
              `dropped ${call.function.arguments.length} chars of late tool arguments (block ${track.anthropicIndex} already closed)`,
            )
          } else {
            // Arguments before id/name: buffer until the block starts.
            track.bufferedArgs += call.function.arguments
          }
        }
      }
    }

    // Do NOT close here: with stream_options.include_usage the usage-only
    // terminal chunk arrives AFTER the finish_reason chunk, and close()
    // needs it. Store the reason and let finish() (stream end) close.
    if (choice.finish_reason) {
      this.lastFinishReason = choice.finish_reason
    }
    return events
  }

  // Upstream ended. Use the stored finish_reason; without one the generation
  // may be truncated. Keep max_tokens even when a tool block has started:
  // neither partial arguments nor valid JSON prove the tool turn completed.
  finish(): StreamEventData[] {
    if (this.finished) return []
    return this.close(this.lastFinishReason ?? "length")
  }

  private jsonDelta(index: number, partialJson: string): StreamEventData {
    return {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: partialJson },
      },
    }
  }

  private messageStart(model: string): StreamEventData {
    this.messageStartSent = true
    const usage = this.latestUsage
    const cached = usage?.prompt_tokens_details?.cached_tokens
    return {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_${crypto.randomUUID()}`,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: Math.max(0, (usage?.prompt_tokens ?? 0) - (cached ?? 0)),
            output_tokens: 0,
            ...(cached !== undefined && { cache_read_input_tokens: cached }),
          },
        },
      },
    }
  }

  private closeOpenTools(events: StreamEventData[]): void {
    const open = [...this.toolCalls.values()]
      .filter((t) => t.open)
      .sort((a, b) => a.anthropicIndex - b.anthropicIndex)
    for (const track of open) {
      events.push({
        event: "content_block_stop",
        data: { type: "content_block_stop", index: track.anthropicIndex },
      })
      track.open = false
    }
  }

  private close(
    reason: NonNullable<OpenAIChoice["finish_reason"]>,
  ): StreamEventData[] {
    if (this.finished) return []
    this.finished = true
    const events: StreamEventData[] = []
    if (!this.messageStartSent) {
      events.push(this.messageStart(this.model))
    }
    this.closeOpenTools(events)
    if (this.textOpen) {
      events.push({
        event: "content_block_stop",
        data: { type: "content_block_stop", index: this.textIndex },
      })
      this.textOpen = false
    }
    let stopReason = mapStopReason(reason)
    if (stopReason === "tool_use" && !this.anyToolStarted) {
      stopReason = "end_turn"
    }
    events.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: usageFromOpenAI(this.latestUsage),
      },
    })
    events.push({ event: "message_stop", data: { type: "message_stop" } })
    return events
  }
}
