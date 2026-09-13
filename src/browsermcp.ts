// Browser control for clgpt sessions, via Playwright MCP.
//
// Claude Code's own Chrome integration (--chrome) is gated on the session's
// OAuth scope and is therefore always off here: clgpt authenticates with
// ANTHROPIC_AUTH_TOKEN against its own adapter, which Claude Code treats as an
// env-var session limited to user:inference. An MCP server has no such gate,
// so browser control has to come from one.
//
// Playwright MCP in --extension mode attaches to a tab already open in the
// user's own browser, with their logins and cookies intact, rather than the
// fresh profile a headless run would get. Other projects do the same thing,
// but this is the one with ~4.6M weekly downloads and active releases, so
// clgpt supports exactly it rather than maintaining a catalogue.

import { readdir } from "node:fs/promises"
import { openaiFetch } from "./api"
import {
  caBundle,
  caChildPath,
  caPaths,
  isCertValidityError,
  isTlsTrustError,
} from "./tls"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { prefsPath } from "./config"

export const EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm"
// The name the Web Store actually shows. It was "Playwright MCP Bridge" here,
// which is how the project describes the extension in its docs but not what
// the listing is called - so searching the store for it finds nothing, and
// following the link lands on a page with a different name, which reads like
// the wrong page.
export const EXTENSION_NAME = "Playwright Extension"
// The id-only form, which the Web Store 301s to the slug form. It is 73
// characters against the slug form's 94, and that is the difference between
// fitting inside a clack note box at 80 columns and being wrapped mid-URL -
// where it can be neither clicked nor copied, which is how a required install
// step went unnoticed.
export const EXTENSION_URL =
  `https://chromewebstore.google.com/detail/${EXTENSION_ID}`
// @0.0.80. The server half is fetched from npm each session, and the extension
// half auto-updates from the Web Store and cannot be pinned alongside it, so
// pinning the server lets the two drift. Pinning also does not
// make browser control work offline - the registry is consulted either way on
// any machine that has not just run that exact version.
//
// Neither spec is a supply-chain control. The repo's bun.lock does not cover
// this package: it is resolved by a bunx subprocess of claude, in its own
// generated lockfile, with no integrity hash clgpt ever sees. A pinned version
// string bounds the window and makes the choice attributable; it verifies
// nothing.
//
// CLGPT_MCP_PACKAGE overrides the spec - an internal mirror, a pinned version,
// a rollback past a bad release.
export const MCP_PACKAGE = "@playwright/mcp@0.0.80"

/** The spec clgpt will actually register, override included. */
export function mcpPackage(): string {
  return process.env.CLGPT_MCP_PACKAGE || MCP_PACKAGE
}

function safePackageSpec(pkg: string): string {
  return pkg
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, "$1[redacted]@")
    .replace(/[?#].*$/, "")
}

function packageHasCredentials(pkg: string): boolean {
  try {
    // npm accepts a tarball URL after a package name, e.g.
    // `@scope/name@https://user:pass/host/pkg.tgz`; parsing the whole spec
    // would miss that embedded URL.
    const embedded = pkg.match(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/i)?.[0]
    if (!embedded) return false
    const url = new URL(embedded)
    return (
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    )
  } catch {
    return false
  }
}

/**
 * Whether probing registry.npmjs.org says anything about the configured spec.
 *
 * Compares the package NAME, not the whole spec: two of CLGPT_MCP_PACKAGE's
 * three documented uses - pinning a version and rolling back past a bad
 * release - leave the registry exactly where it was, so keying this on the
 * full spec switched the check off for a corporate user who had merely pinned.
 * A file:/link: version needs no registry at all, so it counts as neither.
 */
export function probesDefaultRegistry(pkg = mcpPackage()): boolean {
  const at = pkg.lastIndexOf("@")
  // at > 0, not >= 0: lastIndexOf returns -1 for a spec with no "@" and
  // slice(0, -1) then quietly drops the last character ("playwright-mcp" ->
  // "playwright-mc"), and index 0 is a scope marker, not a version separator.
  const name = at > 0 ? pkg.slice(0, at) : pkg
  const version = at > 0 ? pkg.slice(at + 1) : ""
  if (version.includes(":") || version.includes("/")) return false
  return name === MCP_PACKAGE.slice(0, MCP_PACKAGE.lastIndexOf("@"))
}
/** Set by the extension; with it the bridge attaches without a dialog. */
export const TOKEN_ENV = "PLAYWRIGHT_MCP_EXTENSION_TOKEN"

/**
 * The wrapper uses `bun x`, so a Bun runtime is sufficient; npx remains the
 * fallback for anyone running clgpt under Node.
 */
export function runner(): string {
  if (typeof Bun !== "undefined" && Bun.which("bun")) return "bun"
  return "npx"
}

/**
 * Per-profile extension directories, by platform. Edge is included because
 * both the extension and --extension mode support it.
 */
function browserRoots(home = homedir()): string[] {
  switch (platform()) {
    case "darwin":
      return [
        join(home, "Library", "Application Support", "Google", "Chrome"),
        join(home, "Library", "Application Support", "Microsoft Edge"),
      ]
    case "win32": {
      const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local")
      return [
        join(local, "Google", "Chrome", "User Data"),
        join(local, "Microsoft", "Edge", "User Data"),
      ]
    }
    default:
      return [
        join(home, ".config", "google-chrome"),
        join(home, ".config", "chromium"),
        join(home, ".config", "microsoft-edge"),
      ]
  }
}

/**
 * Whether the bridge extension is installed.
 *
 * Deliberately not probed over the network: the MCP server is spawned per
 * conversation, so at clgpt startup nothing is listening and a probe would
 * report "missing" for a working install.
 */
export async function extensionInstalled(home = homedir()): Promise<boolean> {
  for (const root of browserRoots(home)) {
    let profiles: string[]
    try {
      profiles = await readdir(root)
    } catch {
      continue
    }
    for (const profile of profiles) {
      try {
        const ids = await readdir(join(root, profile, "Extensions"))
        if (ids.includes(EXTENSION_ID)) return true
      } catch {
        // not a profile directory, or no extensions in it
      }
    }
  }
  return false
}

/**
 * The --mcp-config payload registering the server for this session only.
 * Null without the extension: the server is only half of it, and registering
 * it alone produces tools that fail on every call.
 */
export function browserMcpConfig(
  installed: boolean,
  /** Null means "no CA", which an ambient CLGPT_CA_BUNDLE must not override. */
  caBundleValue: string | null = process.env.CLGPT_CA_BUNDLE ?? null,
  /** Read here rather than at module load so a test can set it. */
  pkg = mcpPackage(),
): string | null {
  if (!installed) return null
  if (packageHasCredentials(pkg)) {
    throw new Error("CLGPT_MCP_PACKAGE must not contain URL credentials or query parameters; configure private registry credentials through your package manager")
  }
  const env: Record<string, string> = {}
  // npx fetches from the registry over its own TLS, outside clgpt's
  // openaiFetch, so a corporate CA has to be handed down explicitly -
  // otherwise browser control is the one feature that still breaks on the
  // network clgpt was hardened for.
  //
  // One path, and one clgpt actually read: NODE_EXTRA_CA_CERTS names a single
  // file while CLGPT_CA_BUNDLE takes several, and forwarding a path clgpt had
  // already logged as unreadable left the child with nothing but a warning on
  // a stderr claude's UI does not show.
  const first =
    caBundleValue === null
      ? undefined
      : caBundleValue === process.env.CLGPT_CA_BUNDLE
        ? caChildPath()
        : caPaths(caBundleValue)[0]
  if (first) env.NODE_EXTRA_CA_CERTS = first
  // The wrapper reads the stored token immediately before starting MCP. This
  // keeps it out of both Claude's environment and the --mcp-config argv.
  const wrapper = join(import.meta.dir, "../scripts/playwright-wrapper.sh")
  return JSON.stringify({
    mcpServers: {
      playwright: {
        command: wrapper,
        args: [pkg, "--extension"],
        env: {
          ...env,
          CLGPT_MCP_PREFS_PATH: prefsPath(),
          CLGPT_BUN_BIN: process.env.CLGPT_BUN_BIN ?? process.execPath,
        },
      },
    },
  })
}

/** Compose the session-only MCP config without replacing a user's config file. */
export function combinedMcpConfig(
  browserInstalled: boolean,
  webEnabled: boolean,
  webModel?: string,
): string | null {
  const browser = browserMcpConfig(browserInstalled)
  const mcpServers: Record<string, unknown> = browser
    ? ((JSON.parse(browser) as { mcpServers: Record<string, unknown> }).mcpServers)
    : {}
  if (webEnabled) {
    const env: Record<string, string> = {}
    if (webModel) env.CLGPT_WEB_MODEL = webModel
    mcpServers.clgpt_web = {
      command: process.execPath,
      args: [join(import.meta.dir, "webmcp.ts")],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    }
  }
  return Object.keys(mcpServers).length > 0 ? JSON.stringify({ mcpServers }) : null
}

// The extension mints a base64url value; nothing else should be accepted.
// A paste can easily pick up a shell prompt or a stray line, and storing that
// silently produces a token that never works and no clue why.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,}$/

/**
 * Accept what the extension actually puts on screen. It shows the whole
 * assignment, so pasting that verbatim is the obvious move — as is pasting
 * just the value, or a line copied with `export` in front. A multi-line paste
 * keeps only the line carrying the token, since a terminal submits at the
 * first newline and the rest would be lost anyway.
 *
 * Returns null for input that is not a token, so the caller can say so rather
 * than store it.
 */
export function parseToken(input: string): string | null | undefined {
  const lines = input.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return undefined // skipped
  const line =
    lines.find((l) => l.includes(`${TOKEN_ENV}=`)) ??
    lines.find((l) => TOKEN_SHAPE.test(l)) ??
    lines[0]!
  const bare = line.replace(/^export\s+/, "")
  const value = bare.includes(`${TOKEN_ENV}=`)
    ? bare.slice(bare.indexOf(`${TOKEN_ENV}=`) + TOKEN_ENV.length + 1)
    : bare
  const cleaned = value.trim().replace(/^(['"])(.*)\1$/, "$2").trim()
  if (!cleaned) return undefined
  return TOKEN_SHAPE.test(cleaned) ? cleaned : null
}

/** Why browser control will or will not work, in the words the user needs. */
export type RegistryStatus = "ok" | "tls" | "expired" | "blocked" | "slow"

const REGISTRY_PROBE_TIMEOUT_MS = 2_500

/**
 * Whether the registry can actually be reached, and if not, why.
 *
 * The package is resolved from npm at session start, so on a network that
 * blocks or re-signs it the server never starts - and the failure would
 * otherwise surface only as an MCP connection error inside claude, with clgpt's
 * own startup line still claiming success. This has to be a real request: an
 * earlier version ran `bunx --version`, which prints locally and therefore
 * returned "reachable" on an air-gapped machine.
 *
 * A TLS rejection is reported apart from a block because they need different
 * things from the user - one needs their company CA, the other cannot be fixed
 * from here at all.
 */
export async function registryStatus(
  timeoutMs = REGISTRY_PROBE_TIMEOUT_MS,
  /** Overridden in tests; the probe has no other way to reach a TLS failure. */
  url = "https://registry.npmjs.org/@playwright/mcp",
): Promise<RegistryStatus> {
  try {
    // openaiFetch, so a corporate CA applies here exactly as it does to the
    // ChatGPT calls - otherwise this would report "blocked" on the very
    // networks the CA support exists for.
    const res = await openaiFetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok ? "ok" : "blocked"
  } catch (err) {
    if (isTlsTrustError(err)) return "tls"
    // The host answered and the chain may be fine; the dates are not. No CA
    // fixes that, so it is not "tls" - but it is not "cannot reach" either,
    // which is how a lapsed proxy certificate sent the user to their firewall
    // team.
    if (isCertValidityError(err)) return "expired"
    // A 2.5s budget is clgpt's alone - the bunx inside claude has none - so a
    // slow proxy must not be reported as a verdict that tools will not appear.
    if ((err as Error)?.name === "TimeoutError") return "slow"
    return "blocked"
  }
}

/**
 * Fold a status line to the terminal, continuing with a two-space indent.
 *
 * These lines carry a verdict AND a remedy, which is the point of them, so
 * they do not fit an 80-column terminal on one line - and a terminal-wrapped
 * line breaks mid-word and mid-URL, which is how a required install step went
 * unread. Shortening them instead would delete the remedy, so they fold.
 */
function fold(text: string, width = 76): string {
  const out: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    const indent = out.length === 0 ? "" : "  "
    if (line === "") line = indent + word
    else if (`${line} ${word}`.length <= width) line += ` ${word}`
    else {
      out.push(line)
      line = `  ${word}`
    }
  }
  if (line !== "") out.push(line)
  return out.join("\n")
}

/**
 * One line for the startup summary, alongside adapter and model. Whether a
 * session is attached is not knowable here — the server starts per
 * conversation — so this reports what clgpt did, and whether a connect dialog
 * is coming.
 */
export function startupLine(
  enabled: boolean,
  installed: boolean,
  token?: string,
  /** bunx ships with bun, which the installer guarantees; npx is a fallback. */
  hasRunner = Bun.which("bun") !== null || Bun.which("npx") !== null,
  /** Undefined when not checked. */
  registry?: RegistryStatus,
  /** False when clgpt stood aside for a user-supplied --mcp-config. */
  registered?: boolean,
  pkg = mcpPackage(),
  /** Whether a CA bundle actually LOADED - not merely whether the var is set. */
  caLoaded = caBundle() !== undefined,
): string | null {
  if (!enabled) return null
  if (!installed) {
    // Two lines on purpose: the URL has to start a line to survive an 80-column
    // terminal intact, and this is the one clgpt message whose whole job is to
    // get a link in front of the user.
    return (
      `! browser: no tools - "${EXTENSION_NAME}" is not installed in Chrome,\n` +
      `  and only you can add it:\n  ${EXTENSION_URL}`
    )
  }
  if (!hasRunner) {
    return "! browser: neither bunx nor npx found - cannot start Playwright MCP"
  }
  if (registered === false) {
    return "! browser: skipped - your own --mcp-config takes over"
  }
  // Exhaustive by construction: a new RegistryStatus that nobody handles used
  // to fall through to the success line, i.e. silent success for a failure.
  if (registry !== undefined && registry !== "ok") {
    const line: Record<Exclude<RegistryStatus, "ok">, string> = {
      tls:
        "TLS rejected by registry.npmjs.org - browser tools will not appear." +
        // Telling someone to set a variable they already set is the advice
        // this line exists to avoid giving. Keyed on whether a bundle LOADED,
        // not on whether the variable is set.
        (caLoaded
          ? " Your CLGPT_CA_BUNDLE does not cover this chain."
          : " Set CLGPT_CA_BUNDLE to your company CA."),
      expired:
        "registry.npmjs.org presented an expired certificate - browser tools" +
        " will not appear. No CA file fixes this; check the proxy, or your clock.",
      blocked: "cannot reach registry.npmjs.org - browser tools will not appear",
      // No number: the budget is clgpt's own and the bunx inside claude has none.
      slow: "registry.npmjs.org is slow to answer - browser tools may be slow to appear",
    }
    return fold(`! browser: ${line[registry]}`)
  }
  // Name the exact spec: it is user-overridable, it is what runs, and after a
  // bad upstream release "which version did that session run?" has to be
  // answerable from something.
  //
  // And say when nothing was checked - a bare "+" would assert a check that
  // never ran. "Not the default package" rather than "another registry":
  // CLGPT_MCP_PACKAGE names a package, and which registry serves it lives in
  // .npmrc, so a fork published to npmjs is unprobed without being elsewhere.
  const notes = [
    registry === undefined && !probesDefaultRegistry(pkg)
      ? "not the default package, so the registry check was skipped"
      : null,
    token ? null : "connect dialog each session",
  ].filter(Boolean)
  return fold(`+ browser: ${safePackageSpec(pkg)}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`)
}

/**
 * What setup shows before asking anything: the state, without advice to run
 * the very command that is running.
 */
export function setupNote(installed: boolean, pkg = mcpPackage()): string {
  // Three separate things, and the old wording ran them together: it said
  // "clgpt registers no browser server", which reads as though the extension
  // WERE the server. It is not - clgpt registers the server, the extension is
  // what lets that server drive the user's own tab, and the token only skips a
  // click. Conflating them left people unsure what they had actually agreed to.
  if (installed) {
    return (
      `${EXTENSION_NAME} found, so both halves are in place:\n` +
      `  clgpt  registers ${safePackageSpec(pkg)} --extension each session\n` +
      `  you   click the extension to share a tab\n` +
      `Tools then arrive as mcp__playwright__*.\n` +
      `\n` +
      `The token prompt after this is optional - press Enter to skip it.`
    )
  }
  return (
    `Browser control is two halves, and clgpt only owns one:\n` +
    `  clgpt  registers ${safePackageSpec(pkg)}, which it fetches from npm\n` +
    `  you   install one Chrome extension, which clgpt cannot do\n` +
    `\n` +
    `The extension is what lets that server drive YOUR tab, with your\n` +
    `logins, instead of a fresh throwaway profile. Without it clgpt\n` +
    `registers no server at all, since a server with no tab to attach to\n` +
    `would only fail on every call - so no browser tools appear.\n` +
    `\n` +
    `Install "${EXTENSION_NAME}", then restart clgpt:\n` +
    `${EXTENSION_URL}\n` +
    `\n` +
    `Answering Yes now is fine - install it whenever you like.`
  )
}

export function extensionHint(installed: boolean, token?: string, pkg = mcpPackage()): string {
  if (!installed) {
    return (
      `Browser control is ON, but the Chrome extension it needs is not\n` +
      `installed, so clgpt registers no server and no tools appear.\n` +
      `Only you can install it - clgpt cannot:\n` +
      `${EXTENSION_URL}`
    )
  }
  // Whether a session is actually attached cannot be known here: the server
  // starts per conversation and the extension connects to it afterwards. A
  // stored token is the closest thing to a prediction, since it is exactly
  // what removes the manual connect step.
  return (
    `${EXTENSION_NAME} found. Registering ${safePackageSpec(pkg)} --extension\n` +
    `each session. Tools arrive as mcp__playwright__*.\n` +
    (token
      ? `Token stored, so sessions attach without the connect dialog.`
      : `No token stored - optional, and only affects the click: each\n` +
        `session shows the connect dialog instead. The extension offers a\n` +
        `${TOKEN_ENV} value; store it with:\n  pbpaste | clgpt token`)
  )
}
