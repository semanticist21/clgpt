// Durable auth storage: ~/.config/clgpt/auth.json (mode 600).
// Writes go through a temp file + rename so a crash or a pre-existing
// symlink/permission can never leave the token readable or half-written.

import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AuthStore {
  access: string
  refresh: string
  expires: number
  accountId?: string
  residency?: string
}

// Overridable so tests can exercise the real read/merge/write path without
// writing into the user's live install.
let configDir: string | null = null

export function setConfigDir(dir: string | null): void {
  configDir = dir
}

function authDir(): string {
  return configDir ?? join(homedir(), ".config", "clgpt")
}

export function clgptConfigDir(): string {
  return authDir()
}

function authPath(): string {
  return join(authDir(), "auth.json")
}

export async function loadAuth(): Promise<AuthStore | null> {
  try {
    const metadata = await lstat(authPath())
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      if (!metadata.isFile()) return null
      await chmod(authPath(), 0o600)
      const repaired = await lstat(authPath())
      if ((repaired.mode & 0o777) !== 0o600) return null
    }
    const parsed = JSON.parse(await readFile(authPath(), "utf8")) as Partial<AuthStore>
    if (
      typeof parsed.access !== "string" ||
      typeof parsed.refresh !== "string" ||
      typeof parsed.expires !== "number"
    ) return null
    return parsed as AuthStore
  } catch {
    return null
  }
}

export async function saveAuth(auth: AuthStore): Promise<void> {
  await mkdir(authDir(), { recursive: true })
  await chmod(authDir(), 0o700).catch(() => {})
  const tmp = join(authDir(), `.auth.${process.pid}.tmp`)
  const handle = await openExclusive(tmp)
  try {
    await handle.writeFile(JSON.stringify(auth, null, 2) + "\n")
    await handle.close()
    await rename(tmp, authPath())
    await chmod(authPath(), 0o600).catch(() => {})
  } catch (err) {
    await handle.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw err
  }
}

// "wx": fail if the temp file already exists (never truncate through a
// symlink); creation mode 0600.
async function openExclusive(path: string) {
  const { open } = await import("node:fs/promises")
  return open(path, "wx", 0o600)
}

/** Startup options answered once, changed with `clgpt setup`. */
export interface SetupPrefs {
  version: number
  bypass: boolean
  select: boolean
  /** Register the Playwright MCP server for clgpt sessions. Added in v2. */
  browser?: boolean
  /**
   * Playwright MCP's extension token. Skips the connect dialog every session.
   * Kept here because prefs.json is already written 0600, alongside no other
   * secret — the OAuth credential lives in auth.json.
   */
  browserToken?: string
}

export interface Prefs {
  last_model?: string
  setup?: SetupPrefs
}

export function prefsPath(): string {
  return join(authDir(), "prefs.json")
}

export async function loadPrefs(): Promise<Prefs> {
  try {
    const metadata = await lstat(prefsPath())
    if (!metadata.isFile()) return {}
    if ((metadata.mode & 0o777) !== 0o600) {
      await chmod(prefsPath(), 0o600)
      const repaired = await lstat(prefsPath())
      if ((repaired.mode & 0o777) !== 0o600) return {}
    }
    return JSON.parse(await readFile(prefsPath(), "utf8")) as Prefs
  } catch {
    return {}
  }
}

/**
 * Merge into the stored preferences.
 *
 * Every caller holds one concern — the model prompt writes `last_model`, setup
 * writes `setup` — and a plain write let whichever ran last erase the other.
 * Picking a model really did discard the setup answers.
 */
async function writeSecret(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`
  await rm(tmp, { force: true }).catch(() => {})
  const handle = await openExclusive(tmp)
  try {
    await handle.writeFile(data)
  } finally {
    await handle.close()
  }
  await chmod(tmp, 0o600).catch(() => {})
  await rename(tmp, path)
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  await mkdir(authDir(), { recursive: true })
  await chmod(authDir(), 0o700).catch(() => {})
  const merged = { ...(await loadPrefs()), ...prefs }
  // prefs now holds the Playwright extension token, so it gets the same
  // treatment as auth.json: exclusive create, explicit mode, atomic rename.
  // A plain write leaves an existing 0644 file at 0644 and can truncate.
  await writeSecret(prefsPath(), JSON.stringify(merged, null, 2) + "\n")
}

export async function clearAuth(): Promise<void> {
  await rm(authPath()).catch(() => {})
}
