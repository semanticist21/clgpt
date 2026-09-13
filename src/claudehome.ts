// A private CLAUDE_CONFIG_DIR for clgpt sessions.
//
// Claude Code persists a /model pick into its config dir ("saved as your
// default for new sessions"). Pointed at the user's own ~/.claude that leaks
// a ChatGPT slug into plain `claude` runs, and undoing it afterwards cannot
// be made correct: the value is wrong for as long as the session runs, so a
// second claude started meanwhile still reads it, and an abrupt exit leaves
// it behind for the next run to mistake for the user's real setting.
//
// So give claude somewhere else to write. Everything that shapes behaviour is
// symlinked from the real ~/.claude, so plugins, skills, agents and commands
// stay live and shared; only the files claude writes are private. This is the
// same split Anthropic's own self-hosted runner makes when it seeds a config
// dir ("settings, agents/, skills/, …; runtime state excluded").

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** Written by claude during a session — must stay private to clgpt. */
const PRIVATE_ENTRIES = new Set([
  // Holds the model default a /model pick writes.
  "settings.json",
  // Local/managed overlays sit next to it; keep the whole family private so a
  // write never lands in the user's tree.
  "settings.local.json",
  "backups",
])

/**
 * Keep claude's settings private, without letting a ChatGPT slug survive in
 * them. Three cases the previous version got wrong: a missing ~/.claude
 * settings.json left the private copy (and its stale `model`) untouched; a
 * JSONC one was copied verbatim, `model` and all; and rewriting from the
 * user's file every launch discarded whatever claude had persisted in the
 * private one.
 */
async function writeSettings(real: string, home: string): Promise<void> {
  const target = join(home, "settings.json")
  const source = await readFile(join(real, "settings.json"), "utf8").catch(
    () => null,
  )
  const existing = await readFile(target, "utf8").catch(() => null)
  const raw = source ?? existing
  if (raw === null) return
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    delete parsed.model
    await atomicWrite(target, JSON.stringify(parsed, null, 2) + "\n")
  } catch {
    // claude tolerates comments where JSON.parse does not. A line-based regex
    // was worse than useless here: deleting the last key's line left a
    // dangling comma and broke the file outright, it reached "model" keys
    // nested in other objects, and it missed the key when it shared a line.
    // Strip comments, parse, and re-emit — losing the comments is a smaller
    // loss than losing the settings.
    try {
      const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>
      delete parsed.model
      await atomicWrite(target, JSON.stringify(parsed, null, 2) + "\n")
    } catch (err) {
      // Neither form parses: keep the previous private file rather than
      // replace it with something broken, and say so - a stale `model` here
      // is exactly what this function exists to prevent.
      const first = existing === null
      console.error(
        `[clgpt] could not parse ${join(real, "settings.json")} (${(err as Error).message}) - ` +
          (first
            ? "this session starts with NO settings: no env, no hooks, no permissions."
            : "clgpt's copy was left as it was."),
      )
    }
  }
}

/** Comments only — string contents are left alone. */
function stripJsonComments(input: string): string {
  let out = ""
  let inString = false
  let escaped = false
  // Positions in `out` of commas that sit outside any string.
  const commaIndices = new Set<number>()
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === ",") commaIndices.add(out.length)
    if (c === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (c === "/" && input[i + 1] === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++
      i++
      continue
    }
    out += c
  }
  // Trailing commas are legal in JSONC and fatal to JSON.parse — but removing
  // them with a regex over the whole document ate commas inside string values
  // (a permission rule like "Bash(awk '{print $1,}')" lost one). Only drop a
  // comma the scanner emitted outside a string.
  let result = ""
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!
    if (c === "," && commaIndices.has(i)) {
      let j = i + 1
      while (j < out.length && /\s/.test(out[j]!)) j++
      if (out[j] === "}" || out[j] === "]") continue
    }
    result += c
  }
  return result
}

// A second clgpt launch refreshes this file while the first session may be
// reading it; config.ts already writes auth.json this way.
async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`
  try {
    await writeFile(tmp, data, { mode: 0o600 })
    await rename(tmp, path)
  } catch {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

/**
 * `.claude.json` carries trust decisions, MCP server definitions (with their
 * env secrets) and project history. Seeded once so the first session inherits
 * it — but the security-relevant halves are re-synced every launch, because a
 * copy frozen at first run means deleting a compromised MCP server, or
 * withdrawing trust from a project, silently does not apply to clgpt sessions.
 * Everything else stays clgpt's own.
 */
async function syncClaudeState(userHome: string, home: string): Promise<void> {
  const target = join(home, ".claude.json")
  const source = await readFile(join(userHome, ".claude.json"), "utf8").catch(
    () => null,
  )
  if (source === null) {
    await chmod(target, 0o600).catch(() => {})
    return
  }
  const existing = await readFile(target, "utf8").catch(() => null)
  if (existing === null) {
    await copyFile(join(userHome, ".claude.json"), target).catch(() => {})
    await chmod(target, 0o600).catch(() => {})
    return
  }
  try {
    const real = JSON.parse(source) as Record<string, unknown>
    const mine = JSON.parse(existing) as Record<string, unknown>
    mine.mcpServers = real.mcpServers
    const realProjects = (real.projects ?? {}) as Record<string, { hasTrustDialogAccepted?: boolean }>
    const myProjects = (mine.projects ?? {}) as Record<string, { hasTrustDialogAccepted?: boolean }>
    for (const [path, entry] of Object.entries(myProjects)) {
      // Absent means "no opinion", not "withdrawn". clgpt sessions run against
      // the private config dir, so a project only ever used through clgpt is
      // never recorded in the real file at all — forcing false there re-asked
      // the trust question on every single launch.
      const trusted = realProjects[path]?.hasTrustDialogAccepted
      if (trusted !== undefined) entry.hasTrustDialogAccepted = trusted
    }
    await atomicWrite(target, JSON.stringify(mine, null, 2) + "\n")
  } catch {
    // Unparseable on either side: leave what is there rather than lose it.
  }
  await chmod(target, 0o600).catch(() => {})
}

export function claudeHome(home = homedir()): string {
  return join(home, ".config", "clgpt", "claude-home")
}

/**
 * Build (or refresh) the private config dir and return it.
 *
 * Symlinks are refreshed every launch so entries the user adds to ~/.claude
 * show up without any cache to invalidate. Returns null when the real config
 * dir cannot be read, so the caller can fall back to the shared one.
 */
export async function prepareClaudeHome(
  /** Overridden in tests; os.homedir() ignores $HOME on macOS. */
  userHome = homedir(),
): Promise<string | null> {
  const real = join(userHome, ".claude")
  const home = claudeHome(userHome)
  // A missing ~/.claude is no reason to skip isolation - the private dir works
  // fine empty. Only a real read failure is a problem, and returning null then
  // hands the child the user's own config dir, where a /model pick persists.
  // That must never happen quietly.
  let entries: string[]
  try {
    entries = await readdir(real)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `[clgpt] cannot read ${real} (${(err as Error).message}) - refusing to run` +
          " against your own claude config, where a /model pick would persist.",
      )
      throw err
    }
    entries = []
  }
  try {
    await mkdir(home, { recursive: true, mode: 0o700 })
    await chmod(home, 0o700)
  } catch (err) {
    console.error(
      `[clgpt] cannot create ${home} (${(err as Error).message}) - refusing to run` +
        " against your own claude config, where a /model pick would persist.",
    )
    throw err
  }

  for (const name of entries) {
    if (PRIVATE_ENTRIES.has(name)) continue
    const link = join(home, name)
    const target = join(real, name)
    try {
      const existing = await lstat(link).catch(() => null)
      if (existing?.isSymbolicLink()) {
        // Trusting an existing link without checking left ones pointing at a
        // previous $HOME pointing there forever.
        if ((await readlink(link).catch(() => null)) === target) continue
      }
      if (existing) await rm(link, { recursive: true, force: true })
      await symlink(target, link)
    } catch {
      // One unlinkable entry should not sink the session.
    }
  }

  // Reap links whose source is gone: the loop above only visits what exists
  // now, so a deleted entry otherwise dangles here forever.
  const live = new Set(entries)
  for (const name of await readdir(home).catch(() => [])) {
    if (PRIVATE_ENTRIES.has(name) || live.has(name) || name === ".claude.json") {
      continue
    }
    const link = join(home, name)
    const stat = await lstat(link).catch(() => null)
    if (stat?.isSymbolicLink()) await rm(link, { force: true }).catch(() => {})
  }

  await writeSettings(real, home)

  await syncClaudeState(userHome, home)

  return home
}
