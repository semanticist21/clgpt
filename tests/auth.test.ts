import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { chmod, stat, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildAuthorizeUrl,
  extractAccountId,
  extractResidency,
  parseJwtClaims,
  refreshOpenAIToken,
} from "../src/auth"
import { loadAuth, saveAuth, setConfigDir } from "../src/config"
import { buildModelPickerFrom } from "../src/spawn"
import { discoverModels, invalidateOpenAIToken, takeDiscoverySoftFailure, upstreamModels } from "../src/token"

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

afterEach(() => setConfigDir(null))

describe("ChatGPT OAuth", () => {
  test("builds a PKCE authorize URL for clgpt", () => {
    const url = new URL(buildAuthorizeUrl("state", "challenge"))
    expect(url.origin).toBe("https://auth.openai.com")
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
    expect(url.searchParams.get("code_challenge")).toBe("challenge")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("originator")).toBe("clgpt")
  })

  test("extracts account and residency claims from an id token", () => {
    const token = `header.${encode({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
        chatgpt_compute_residency: "us",
      },
    })}.signature`
    const claims = parseJwtClaims(token)
    expect(extractAccountId(claims)).toBe("acct_test")
    expect(extractResidency(claims)).toBe("us")
  })

  test("falls back to the first organization and ignores no_constraint residency", () => {
    const claims = { organizations: [{ id: "org_test" }], chatgpt_compute_residency: "no_constraint" }
    expect(extractAccountId(claims)).toBe("org_test")
    expect(extractResidency(claims)).toBeUndefined()
  })

  test("stores credentials with restrictive permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clgpt-auth-"))
    setConfigDir(dir)
    await saveAuth({ access: "access", refresh: "refresh", expires: 123 })
    const file = await stat(join(dir, "auth.json"))
    expect(file.mode & 0o777).toBe(0o600)
    await chmod(join(dir, "auth.json"), 0o644)
    expect(await loadAuth()).not.toBeNull()
    expect((await stat(join(dir, "auth.json"))).mode & 0o777).toBe(0o600)
    expect(await loadAuth()).toMatchObject({ access: "access", refresh: "refresh", expires: 123 })
    await rm(dir, { recursive: true, force: true })
  })

  test("refreshes access credentials and preserves a missing refresh token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clgpt-refresh-"))
    setConfigDir(dir)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      Response.json({ access_token: "new-access", expires_in: 7200 })) as unknown as typeof fetch
    try {
      const refreshed = await refreshOpenAIToken({
        access: "old-access",
        refresh: "old-refresh",
        expires: 1,
        accountId: "acct_test",
      })
      expect(refreshed.access).toBe("new-access")
      expect(refreshed.refresh).toBe("old-refresh")
      expect(refreshed.expires).toBeGreaterThan(Date.now())
    } finally {
      globalThis.fetch = originalFetch
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test("uses the signed-in Codex catalog and falls back on lookup failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clgpt-models-"))
  const savedUpstream = process.env.CLGPT_UPSTREAM
  const savedModels = process.env.CLGPT_MODELS
  delete process.env.CLGPT_UPSTREAM
  delete process.env.CLGPT_MODELS
  setConfigDir(dir)
  invalidateOpenAIToken()
  const fetchMock = spyOn(globalThis, "fetch")
  const model = {
    slug: "gpt-7-codex",
    display_name: "New Codex model",
    visibility: "list",
    context_window: 272_000,
    max_context_window: 872_000,
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
  }
  const catalogResponse = () => Response.json({ models: [
    model,
    { slug: "gpt-6-astra", visibility: "list" },
    { slug: "gpt-7-hidden", visibility: "hide" },
    { slug: "gpt-7-preview", visibility: "list" },
    { slug: "claude-sonnet-5", visibility: "list" },
    { slug: "gpt-7[1m]", visibility: "list" },
    null,
  ] })
  try {
    await saveAuth({
      access: "catalog-token", refresh: "unused", accountId: "test-account",
      residency: "us", expires: Date.now() + 3_600_000,
    })
    fetchMock.mockResolvedValueOnce(catalogResponse())

    expect((await discoverModels()).sonnet).toBe(model.slug)
    const [input, init] = fetchMock.mock.calls[0]!
    const url = new URL(String(input))
    expect(url.origin + url.pathname).toBe("https://chatgpt.com/backend-api/codex/models")
    expect(url.searchParams.get("client_version")).toMatch(/^\d+\.\d+\.\d+$/)
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer catalog-token")
    expect(headers.get("chatgpt-account-id")).toBe("test-account")
    expect(headers.get("x-openai-internal-codex-residency")).toBe("us")
    expect(upstreamModels().map(({ id }) => id)).toEqual([model.slug, "gpt-6-astra"])
    expect(upstreamModels()[0]).toMatchObject({
      name: model.display_name, endpoints: ["/responses"], efforts: ["low", "high"],
      maxPromptTokens: 272_000, maxContextTokens: 872_000,
    })
    expect(buildModelPickerFrom(upstreamModels())?.options.some((option) => option.model === model.slug)).toBe(true)
    expect(takeDiscoverySoftFailure()).toBeNull()

    process.env.CLGPT_MODELS = model.slug
    fetchMock.mockResolvedValueOnce(catalogResponse())
    await discoverModels()
    expect(upstreamModels().map(({ id }) => id)).toEqual([model.slug])

    process.env.CLGPT_MODELS = "gpt-5.5"
    fetchMock.mockResolvedValueOnce(catalogResponse())
    await expect(discoverModels()).rejects.toThrow("CLGPT_MODELS matches no models")
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
    expect((await discoverModels()).sonnet).toBe("gpt-5.5")
    expect(upstreamModels().map(({ id }) => id)).toEqual(["gpt-5.5"])
    expect(takeDiscoverySoftFailure()).toContain("HTTP 503")
  } finally {
    fetchMock.mockRestore()
    invalidateOpenAIToken()
    if (savedUpstream === undefined) delete process.env.CLGPT_UPSTREAM
    else process.env.CLGPT_UPSTREAM = savedUpstream
    if (savedModels === undefined) delete process.env.CLGPT_MODELS
    else process.env.CLGPT_MODELS = savedModels
    await rm(dir, { recursive: true, force: true })
  }
})
