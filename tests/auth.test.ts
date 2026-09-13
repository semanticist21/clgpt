import { afterEach, describe, expect, test } from "bun:test"
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
