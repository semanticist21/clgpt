import { ensureOpenAITokenForMcp } from "./auth"
import { openaiBaseUrl, openaiFetch, openaiRequestHeaders } from "./api"
import { fetchContent, WebFetchError } from "./webfetch"

type Rpc = { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown> }
let unavailable: string | null = null

function reply(id: Rpc["id"], result: unknown): void { if (id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n") }
function failure(message: string): { content: [{ type: "text"; text: string }]; isError: true } { return { content: [{ type: "text", text: message }], isError: true } }

async function nativeSearch(query: string): Promise<string> {
  if (unavailable) throw new WebFetchError(`web unavailable for this session: ${unavailable}`)
  const identity = await ensureOpenAITokenForMcp()
  const model = process.env.CLGPT_WEB_MODEL
  if (!model) throw new WebFetchError("ChatGPT native web search is unavailable: no Responses-capable model was discovered")
  const response = await openaiFetch(`${openaiBaseUrl()}/responses`, {
    method: "POST",
    headers: openaiRequestHeaders(identity.access, identity.accountId, { agentInitiated: true, accept: "text/event-stream" }),
    body: JSON.stringify({ model, input: [{ role: "user", content: [{ type: "input_text", text: query }] }], tools: [{ type: "web_search" }], include: ["web_search_call.action.sources"], stream: true, store: false }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new WebFetchError(`ChatGPT native web search failed: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`)
  const reader = response.body?.getReader()
  if (!reader) throw new WebFetchError("ChatGPT native web search returned no stream")
  const decoder = new TextDecoder()
  let buffer = ""
  let text = ""
  const sources = new Map<string, string>()
  const consume = (raw: string) => {
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue
      try {
        const event = JSON.parse(line.slice(6)) as Record<string, unknown>
        if (event.type === "response.failed" || event.type === "error") {
          const error = event.error as Record<string, unknown> | undefined
          throw new WebFetchError(`ChatGPT native web search failed: ${String(error?.message ?? event.message ?? "provider stream error")}`)
        }
        if (typeof event.delta === "string") text += event.delta
        if (event.type === "response.output_text.done" && typeof event.text === "string" && !text) text = event.text
        const output = event.item as Record<string, unknown> | undefined
        const list = (output?.sources ?? (output?.action as Record<string, unknown> | undefined)?.sources ?? (event.action as Record<string, unknown> | undefined)?.sources) as Array<Record<string, unknown>> | undefined
        for (const source of list ?? []) if (typeof source.url === "string") sources.set(source.url, typeof source.title === "string" ? source.title : source.url)
      } catch { /* partial/non-JSON SSE lines are ignored */ }
    }
  }
  while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const parts = buffer.split("\n\n"); buffer = parts.pop() ?? ""; for (const part of parts) consume(part) }
  consume(buffer)
  if (!text.trim()) throw new WebFetchError("ChatGPT native web search returned no answer")
  if (sources.size) text += "\n\nSources:\n" + [...sources].map(([url, title]) => `- [${title}](${url})`).join("\n")
  return text
}

const tools = [
  { name: "web_search", description: "Search the web using ChatGPT native web search.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
  { name: "web_fetch", description: "Fetch and extract readable content from a public URL.", inputSchema: { type: "object", properties: { url: { type: "string" }, max_chars: { type: "integer", minimum: 1000, maximum: 100000 } }, required: ["url"], additionalProperties: false } },
]

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (unavailable) return failure(`web unavailable for this session: ${unavailable}`)
  try {
    if (name === "web_search") return { content: [{ type: "text", text: await nativeSearch(String(args.query ?? "")) }] }
    if (name === "web_fetch") { const maxChars = args.max_chars === undefined ? 30_000 : Number(args.max_chars); if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 100_000) return failure("max_chars must be an integer between 1000 and 100000"); const result = await fetchContent(String(args.url ?? ""), maxChars); return { content: [{ type: "text", text: JSON.stringify(result) }] } }
    return failure(`unknown web tool: ${name}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (name === "web_search") unavailable = message
    return failure(message)
  }
}

process.stdin.setEncoding("utf8")
let input = ""
let queue = Promise.resolve()
process.stdin.on("data", (chunk: string) => {
  input += chunk
  for (const line of input.split("\n").slice(0, -1)) queue = queue.then(() => handle(line))
  input = input.split("\n").pop() ?? ""
})
async function handle(line: string): Promise<void> {
  if (!line.trim()) return
  let message: Rpc
  try { message = JSON.parse(line) as Rpc } catch { return }
  if (message.method === "initialize") return reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "clgpt-web", version: "0.1.0" } })
  if (message.method === "ping") return reply(message.id, {})
  if (message.method === "tools/list") return reply(message.id, { tools })
  if (message.method === "tools/call") { const params = message.params ?? {}; return reply(message.id, await call(String(params.name), (params.arguments ?? {}) as Record<string, unknown>)) }
  if (message.id !== undefined) reply(message.id, { error: { code: -32601, message: `Method not found: ${message.method}` } })
}
