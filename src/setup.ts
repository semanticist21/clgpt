// One-time startup preferences, so the flags you always pass don't have to be
// typed every run. Asked once on the first interactive launch, changed later
// with `clgpt setup`, and overridable per run with the --no-* flags.

import * as p from "@clack/prompts"
import {
  TOKEN_ENV,
  combinedMcpConfig,
  extensionInstalled,
  parseToken,
  setupNote,
} from "./browsermcp"
import { loadPrefs, savePrefs, type SetupPrefs } from "./config"

/** Bump when an option is added, so existing users get told once. */
export const SETUP_VERSION = 3

export interface SetupOverrides {
  bypass?: boolean
  select?: boolean
  browser?: boolean
  web?: boolean
}

// What the first-run prompts come pre-filled with: these are the options
// people install clgpt for, so Enter-through should land on the useful setup.
// A future option added to an EXISTING setup is absent from the stored
// object, i.e. off, which is the conservative direction for a change nobody
// asked for.
export const SETUP_DEFAULTS: Omit<SetupPrefs, "version"> = {
  bypass: true,
  select: true,
  browser: true,
  web: true,
}

export async function runSetup(): Promise<SetupPrefs> {
  const prefs = await loadPrefs()
  const current = prefs.setup ?? { ...SETUP_DEFAULTS, version: SETUP_VERSION }

  p.intro("clgpt setup - save the flags you would otherwise type every run")
  const ask = async (message: string, initialValue: boolean): Promise<boolean> => {
    const answer = await p.confirm({ message, initialValue })
    if (p.isCancel(answer)) {
      p.cancel("Cancelled - keeping the previous settings")
      process.exit(0)
    }
    return answer as boolean
  }

  // Sequential rather than one object literal: the browser follow-ups have to
  // run between the browser answer and the next question, and inside a literal
  // every property is evaluated before any code after it.
  const setup: SetupPrefs = {
    ...SETUP_DEFAULTS,
    version: SETUP_VERSION,
    // Carried regardless of the answers below: turning browser control off for
    // a while should not make the user paste the token again afterwards.
    browserToken: current.browserToken,
  }

  setup.bypass = await ask(
    "Run without permission prompts? (--dangerously-skip-permissions)",
    current.bypass,
  )

  // Web defaults to on: the adapter maps Claude's built-in WebSearch onto
  // ChatGPT's native web_search. `--no-web` disables it for one run.
  // Claude's own Chrome integration cannot work here, so there is nothing to
  // ask about it - only an alternative to offer.
  setup.browser = await ask(
    "Claude Chrome is not available in clgpt.\n" +
      "  Enable Playwright MCP for browser control instead?",
    current.browser ?? true,
  )
  if (setup.browser) {
    p.note(setupNote(await extensionInstalled()), "Playwright MCP")
    const token = await p.text({
      message:
        `${TOKEN_ENV} (optional) - skips the connect dialog every session.\n` +
        "  Paste the whole line from the extension, or just the value.\n" +
        "  Enter to skip, or set it later with: clgpt token",
      placeholder: "leave empty to skip",
      defaultValue: current.browserToken ?? "",
      // Rejecting here beats storing a stray paste that would never work.
      validate: (value) =>
        parseToken(value ?? "") === null
          ? "That does not look like the token - it is a long string of letters, digits, - and _."
          : undefined,
    })
    if (!p.isCancel(token)) {
      const parsed = parseToken(String(token))
      if (parsed) setup.browserToken = parsed
    }
  }

  setup.select = await ask(
    "Pick a model each time clgpt starts?",
    current.select,
  )

  await savePrefs({ ...prefs, setup })
  p.outro(
    "Saved. Re-run `clgpt setup` to change it, or turn one off for a single\n" +
      "run with --no-bypass / --no-select / --no-browser / --no-web.",
  )
  return setup
}

/**
 * The saved setup, or null when it has never been run. Also reports a version
 * bump once: a new option defaults to off, and saying so beats leaving it
 * undiscovered — but nagging on every launch afterwards does not.
 */
export async function loadSetup(): Promise<SetupPrefs | null> {
  const prefs = await loadPrefs()
  if (!prefs.setup) return null
  if (prefs.setup.version < SETUP_VERSION) {
    console.error(
      "[clgpt] New setup options are available (off by default) - run `clgpt setup` to enable them",
    )
    // Record that the notice was shown; the options themselves stay off.
    await savePrefs({
      ...prefs,
      setup: { ...prefs.setup, version: SETUP_VERSION },
    }).catch(() => {})
  }
  return prefs.setup
}

/**
 * Claude flags implied by the saved setup, minus anything the user already
 * passed by hand or turned off for this run. Passing a flag twice is not
 * harmless for every claude flag, so each is added only when absent.
 */
export function setupClaudeArgs(
  setup: SetupPrefs | null,
  overrides: SetupOverrides,
  claudeArgs: string[],
  /** Whether the Playwright MCP Bridge extension is installed. */
  browserExtension = false,
): string[] {
  if (!setup) return []
  // Match the `--flag=value` form too: an exact comparison let a user's own
  // --mcp-config=x.json through, and clgpt then injected a second one.
  const has = (flag: string) =>
    claudeArgs.some((a) => a === flag || a.startsWith(`${flag}=`))
  const out: string[] = []
  if (
    setup.bypass &&
    overrides.bypass !== false &&
    !has("--dangerously-skip-permissions") &&
    // An explicit permission mode is a deliberate choice; do not override it.
    !has("--permission-mode")
  ) {
    out.push("--dangerously-skip-permissions")
  }
  // Registered per session rather than written into the user's MCP config, so
  // clgpt never edits configuration that outlives it.
  const browserRequested = setup.browser && overrides.browser !== false && browserExtension
  if (browserRequested && !has("--mcp-config")) {
    const config = combinedMcpConfig(browserExtension)
    if (config) out.push("--mcp-config", config)
  }
  return out
}

/**
 * Environment the saved setup implies for the claude child.
 *
 * The extension token travels here rather than in the --mcp-config payload:
 * that payload is an argv element, and argv is readable by other local users.
 * MCP servers inherit claude's environment, so this route reaches the same
 * place without publishing it.
 */
export function setupEnv(
  setup: SetupPrefs | null,
  overrides: SetupOverrides,
): Record<string, string> {
  // Stored credentials are read by the short-lived MCP wrapper, not injected
  // into Claude's environment where shell commands and prompt-injected tools
  // could read them. An explicitly exported token remains the user's choice.
  return {}
}

/**
 * Which model a session runs when the startup prompt is skipped, or undefined
 * to pass no --model and leave claude on its own default.
 *
 * Turning the prompt off means "stop asking me", not "forget what I picked", so
 * the remembered choice is reused. An explicit `clgpt --model X` still wins: it
 * reaches claude through claudeArgs and runClaude stands aside when it sees one.
 *
 * Both candidates are checked against what the account actually serves. The
 * fallback needs it as much as the remembered pick does: discoverModels caches
 * the model list BEFORE deciding it found no claude-sonnet slug, so a plan
 * without Claude models yields a non-empty list and a sonnet slot that is only
 * a default guess. Asserting that as --model would fail a session that used to
 * work by passing nothing at all.
 */
export function modelWithoutPrompt(
  remembered: string | undefined,
  /** Slugs the account currently offers, as the picker would list them. */
  offered: ReadonlyArray<string>,
  fallback: string,
): string | undefined {
  if (remembered && offered.includes(remembered)) return remembered
  return offered.includes(fallback) ? fallback : undefined
}

/** Whether to show the startup model picker for this run. */
export function shouldSelectModel(
  setup: SetupPrefs | null,
  overrides: SetupOverrides,
): boolean {
  if (overrides.select === false) return false
  // Before setup runs, keep the long-standing behaviour of asking.
  return setup === null ? true : setup.select
}
