import { lookup } from "node:dns/promises"
import { Readability } from "@mozilla/readability"
import { parseHTML } from "linkedom"
import TurndownService from "turndown"

const MAX_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5
const FETCH_TIMEOUT_MS = 20_000

export class WebFetchError extends Error {}

export function privateAddress(address: string): boolean {
  const value = address.toLowerCase()
  if (value.startsWith("::ffff:")) return privateAddress(value.slice(7))
  if (value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") || value.startsWith("ff") || value.startsWith("2001:db8:")) return true
  const octets = value.split(".").map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b, c] = octets
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)
}

async function publicAddress(url: URL): Promise<string> {
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new WebFetchError("web_fetch DNS lookup timed out")), 5_000)),
  ])
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new WebFetchError("web_fetch blocked a private or local destination")
  return addresses[0]!.address
}

async function validateUrl(raw: string): Promise<URL> {
  let url: URL
  try { url = new URL(raw) } catch { throw new WebFetchError("web_fetch requires a valid URL") }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new WebFetchError("web_fetch only permits credential-free HTTP(S) URLs")
  }
  await publicAddress(url)
  return url
}

async function pinnedFetch(url: URL, init: RequestInit): Promise<Response> {
  const address = await publicAddress(url)
  const target = new URL(url)
  const originalHost = target.host
  target.hostname = address
  const headers = new Headers(init.headers)
  headers.set("host", originalHost)
  const options = { ...init, headers } as RequestInit & { tls?: { serverName: string } }
  if (url.protocol === "https:") options.tls = { serverName: url.hostname }
  return fetch(target, options as RequestInit)
}

async function readLimited(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new WebFetchError("web_fetch received an empty response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) throw new WebFetchError("web_fetch refused a response larger than 5 MB")
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  try {
    const module = await import("unpdf") as { extractText?: (data: Uint8Array) => Promise<unknown> }
    if (!module.extractText) throw new Error("extractText unavailable")
    const result = await module.extractText(bytes)
    if (typeof result === "string") return result
    const text = (result as { text?: string | string[] } | null)?.text
    return Array.isArray(text) ? text.join("\n") : text ?? ""
  } catch { throw new WebFetchError("web_fetch could not extract text from this PDF") }
}

export async function fetchContent(rawUrl: string, maxChars = 30_000): Promise<{ url: string; contentType: string; text: string; title?: string }> {
  let url = await validateUrl(rawUrl)
  let response: Response | undefined
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    response = await pinnedFetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get("location")
    if (!location || redirects === MAX_REDIRECTS) throw new WebFetchError("web_fetch followed too many redirects")
    url = await validateUrl(new URL(location, url).toString())
  }
  if (!response) throw new WebFetchError("web_fetch did not receive a response")
  if (!response.ok) throw new WebFetchError(`web_fetch failed: HTTP ${response.status}`)
  const bytes = await readLimited(response)
  const contentType = (response.headers.get("content-type") ?? "application/octet-stream").split(";", 1)[0].trim().toLowerCase()
  if (contentType === "application/pdf" || url.pathname.toLowerCase().endsWith(".pdf")) {
    return { url: url.toString(), contentType, text: (await pdfText(bytes)).trim().slice(0, maxChars) }
  }
  const source = new TextDecoder().decode(bytes)
  if (contentType === "application/json" || contentType === "text/plain" || contentType === "text/csv" || contentType === "application/xml") {
    return { url: url.toString(), contentType, text: source.slice(0, maxChars) }
  }
  if (!contentType.includes("html")) throw new WebFetchError(`web_fetch does not support ${contentType || "this content type"}`)
  const { document } = parseHTML(source)
  const article = new Readability(document as unknown as Document).parse()
  if (!article?.content) throw new WebFetchError("web_fetch found no readable static content; use browser control for JavaScript-only pages")
  const markdown = new TurndownService({ codeBlockStyle: "fenced" }).turndown(article.content).trim()
  if (!markdown) throw new WebFetchError("web_fetch found no readable static content; use browser control for JavaScript-only pages")
  return { url: url.toString(), contentType, title: article.title || undefined, text: markdown.slice(0, maxChars) }
}
