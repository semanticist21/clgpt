// Bridge between ChatGPT's model slugs and Claude Code's own model catalog.
//
// ChatGPT spells versions with dots ("claude-haiku-4.5"); Claude Code's
// catalog uses dashes ("claude-haiku-4-5"). When the dashed form is a real
// catalog id we advertise that instead, and the row needs no `behavesAs` —
// Claude Code then applies the model's genuine context window, effort tiers
// and prompt profile. Only slugs with no catalog twin fall back to
// `behavesAs`, which borrows another model's client-side handling.

/**
 * Fallback catalog, captured from Claude Code 2.1.268. Only used when the
 * installed binary cannot be scanned (see loadCatalog) — pinning the real
 * list to a clgpt release would make every claude upgrade a silent liability:
 * an id that moves out from under us drops its row from /model with no error.
 */
const FALLBACK_CATALOG_IDS: readonly string[] = [
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-haiku-4",
  "claude-haiku-4-5",
  "claude-opus-4",
  "claude-opus-4-0",
  "claude-opus-4-1",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-3-7",
  "claude-sonnet-4",
  "claude-sonnet-4-0",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
]

// Resolved once per process from the installed claude binary, cached on disk
// per version so the ~0.7s scan is paid only after a claude upgrade.
let catalogIds: Set<string> = new Set(FALLBACK_CATALOG_IDS)

/** Ids the installed Claude Code knows. */
export function catalogModelIds(): ReadonlySet<string> {
  return catalogIds
}

/** Claude Code's newest id per family, used to resolve `behavesAs` targets. */
export const LATEST_PER_FAMILY: Readonly<Record<ModelFamily, string>> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5-1",
}

export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable"

export function familyOf(id: string): ModelFamily {
  if (id.includes("opus")) return "opus"
  if (id.includes("haiku")) return "haiku"
  if (id.includes("fable")) return "fable"
  return "sonnet"
}

/**
 * The id to show Claude Code for an upstream slug, or null when the slug has
 * no catalog twin. Returns the slug itself when it is already a catalog id.
 */
/**
 * Read the catalog out of the claude binary, so clgpt tracks whatever version
 * is actually installed instead of whatever was current when clgpt shipped.
 * Cached by binary path + size + mtime; any failure keeps the fallback.
 */
export async function loadCatalog(binary: string): Promise<void> {
  const { readFile, writeFile, mkdir, stat } = await import("node:fs/promises")
  const { homedir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = join(homedir(), ".config", "clgpt")
  let key: string
  try {
    const s = await stat(binary)
    key = `${s.size}-${Math.round(s.mtimeMs)}`
  } catch {
    return
  }
  const cache = join(dir, "catalog.json")
  try {
    const saved = JSON.parse(await readFile(cache, "utf8")) as {
      key?: string
      ids?: string[]
    }
    if (saved.key === key && saved.ids?.length) {
      catalogIds = new Set(saved.ids)
      return
    }
  } catch {
    // no cache yet, or unreadable — rescan
  }
  try {
    const bytes = await readFile(binary)
    const found = new TextDecoder("latin1")
      .decode(bytes)
      .match(/claude-(?:opus|sonnet|haiku|fable)-\d[0-9a-z-]*/g)
    if (!found?.length) return
    const ids = [...new Set(found)]
    catalogIds = new Set(ids)
    await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {})
    await writeFile(cache, JSON.stringify({ key, ids })).catch(() => {})
  } catch {
    // unreadable binary — the fallback list still applies
  }
}

export function advertisedId(upstreamId: string): string | null {
  if (catalogIds.has(upstreamId)) return upstreamId
  const dashed = upstreamId.replace(/\./g, "-")
  return catalogIds.has(dashed) ? dashed : null
}

/**
 * A catalog id whose client-side handling a non-catalog model can borrow.
 * Prefers a same-family model the upstream actually serves, so the mapping
 * ages with both sides at once. The target only has to be an id Claude Code
 * knows, not one the upstream serves, so a static per-family id backs it up —
 * without that, an upstream carrying no Claude models at all would leave every
 * row unborrowed and therefore unofferable, i.e. an empty /model.
 */
export function resolveBehavesAs(
  family: ModelFamily,
  upstreamIds: readonly string[],
): string {
  const known = upstreamIds
    .map(advertisedId)
    .filter((id): id is string => id !== null)
  const catalog = [...catalogIds]
  return (
    known.find((id) => familyOf(id) === family) ??
    known.find((id) => familyOf(id) === "sonnet") ??
    known[0] ??
    // Nothing the upstream serves is catalog-known, so fall back to the
    // installed catalog itself rather than to an id baked into clgpt.
    (catalogIds.has(LATEST_PER_FAMILY[family])
      ? LATEST_PER_FAMILY[family]
      : (catalog.find((id) => familyOf(id) === family) ??
        catalog.find((id) => familyOf(id) === "sonnet") ??
        catalog[0] ??
        LATEST_PER_FAMILY[family]))
  )
}
