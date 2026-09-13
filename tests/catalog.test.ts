import { describe, expect, test } from "bun:test"
import {
  catalogModelIds,
  loadCatalog,
  advertisedId,
  familyOf,
  resolveBehavesAs,
} from "../src/catalog"

describe("advertisedId", () => {
  test("rewrites dot-form slugs onto their catalog twin", () => {
    expect(advertisedId("claude-haiku-4.5")).toBe("claude-haiku-4-5")
    expect(advertisedId("claude-fable-5.1")).toBe("claude-fable-5-1")
    expect(advertisedId("claude-opus-4.8")).toBe("claude-opus-4-8")
  })

  test("passes through slugs that are already catalog ids", () => {
    expect(advertisedId("claude-sonnet-5")).toBe("claude-sonnet-5")
    expect(advertisedId("claude-opus-5")).toBe("claude-opus-5")
  })

  test("returns null when there is no catalog twin", () => {
    // A real ChatGPT slug with no catalog counterpart.
    expect(advertisedId("claude-opus-4.8-fast")).toBeNull()
    expect(advertisedId("gpt-6-astra")).toBeNull()
    expect(advertisedId("kimi-k3")).toBeNull()
  })
})

describe("resolveBehavesAs", () => {
  test("prefers a same-family model the upstream actually serves", () => {
    expect(resolveBehavesAs("opus", ["claude-opus-5", "claude-sonnet-5"])).toBe(
      "claude-opus-5",
    )
  })

  test("falls back to a catalog id even when the upstream has no Claude models", () => {
    // Without this the row carries no behavesAs, and claude declines to
    // offer it at all — an empty /model.
    const target = resolveBehavesAs("sonnet", ["gpt-6-astra", "kimi-k3"])
    expect(catalogModelIds().has(target)).toBe(true)
  })

  test("always resolves to something claude knows", () => {
    for (const family of ["opus", "sonnet", "haiku", "fable"] as const) {
      expect(catalogModelIds().has(resolveBehavesAs(family, []))).toBe(true)
    }
  })
})

describe("familyOf", () => {
  test("reads the family out of the slug, defaulting to sonnet", () => {
    expect(familyOf("claude-opus-4.8-fast")).toBe("opus")
    expect(familyOf("claude-haiku-4.5")).toBe("haiku")
    expect(familyOf("claude-fable-5.1")).toBe("fable")
    expect(familyOf("gpt-6-astra")).toBe("sonnet")
  })
})

describe("loadCatalog", () => {
  test("reads the installed binary, caches it, and survives a bad path", async () => {
    const binary = "/Users/kkomi/.local/share/claude/versions/2.1.269"
    const before = catalogModelIds().size
    // A path that cannot be read must never shrink the catalog — the
    // built-in fallback has to keep standing.
    await loadCatalog("/nonexistent/claude")
    expect(catalogModelIds().size).toBe(before)

    if (!(await Bun.file(binary).exists())) return
    await loadCatalog(binary)
    const scanned = catalogModelIds()
    // The point of scanning: track the installed version, not clgpt's release.
    expect(scanned.size).toBeGreaterThan(before)
    expect(scanned.has("claude-sonnet-5")).toBe(true)

    // Second call comes from the on-disk cache, so it must be fast enough
    // that a claude upgrade is the only time anyone pays for the scan.
    const t0 = performance.now()
    await loadCatalog(binary)
    expect(performance.now() - t0).toBeLessThan(200)
    expect(catalogModelIds().size).toBe(scanned.size)
  })
})
