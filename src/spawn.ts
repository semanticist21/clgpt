// Launch the stock claude CLI pointed at the local adapter. Endpoint and
// model overrides are injected via `claude --settings '<json>'`, which ranks
// above user/project settings (so an existing ~/.claude/settings.json env
// block cannot swallow it) without touching any config file. The same env is
// also merged into the child process environment.

import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  advertisedId,
  familyOf,
  loadCatalog,
  resolveBehavesAs,
} from "./catalog"
import {
  modelInfo,
  upstreamModels,
  type ModelMapping,
  type UpstreamModel,
} from "./token"
import { prepareClaudeHome } from "./claudehome"
import { normalizeModel } from "./translate"
import { ONE_MILLION_TOKENS, fallbackInputWindow } from "./tokens"

/** Endpoints a model must serve to hold a conversation at all. */
const CHAT_ENDPOINTS = ["/v1/messages", "/responses", "/chat/completions"]

// ChatGPT plumbing that answers like a model but is not one to pick: these
// declare a role as their capability family ("search-agent") where a real
// model declares its own name ("gpt-4o"). Hidden by default; CLGPT_SHOW_INTERNAL
// brings them back, which matters on plans where little else is available.
const INTERNAL_FAMILIES = new Set([
  "search-agent",
  "exec-agent",
  "trajectory-compaction",
])

export function windowOf(m: UpstreamModel): number | undefined {
  return m.maxPromptTokens ?? m.maxContextTokens
}

export function buildSettingsEnv(
  baseUrl: string,
  models: ModelMapping,
  defaultModel?: string,
  /** Defaults to the discovery cache; injected directly in tests. */
  modelMeta?: UpstreamModel | null,
): Record<string, string> {
  const selected = defaultModel
  // The selection may be an advertised catalog-form id; the discovery cache
  // is keyed by upstream slug, so resolve before looking it up.
  const info =
    modelMeta === undefined ? (selected ? modelInfo(normalizeModel(selected)) : undefined) : modelMeta
  // Claude models are served through ChatGPT's native Anthropic endpoint, so
  // the adapter forwards thinking blocks untouched; only the translation
  // dialects need them suppressed.
  const native = info?.endpoints.includes("/v1/messages") === true
  // Prefer the upstream's own prompt budget so auto-compact fires before the
  // model rejects the conversation.
  const fallbackWindow = fallbackInputWindow(upstreamModels().filter(conversational).map(windowOf))
  const window = info?.maxPromptTokens ?? info?.maxContextTokens ?? fallbackWindow

  return {
    ANTHROPIC_BASE_URL: baseUrl,
    // Keep the bearer token in the child environment only. Putting it in the
    // --settings JSON makes it visible in the Claude process argv to other
    // local users; buildLaunchEnv adds it after this settings blob is built.
    // ANTHROPIC_MODEL is deliberately NOT set: it pins the session model, so
    // claude reports "ANTHROPIC_MODEL is set to X — new sessions use that
    // while it is set" and every /model switch becomes cosmetic. The startup
    // choice travels as `--model` instead, which /model can override.
    ANTHROPIC_DEFAULT_OPUS_MODEL: models.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: models.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: models.haiku,
    ANTHROPIC_DEFAULT_FABLE_MODEL: models.fable,
    // Gateway discovery is deliberately NOT enabled: Claude Code keeps only
    // ids matching /claude|anthropic/i, so it would add nothing the picker
    // lineup does not already carry — while writing a stale adapter port
    // into the user's own ~/.claude/cache/gateway-models.json.
    // Keep traffic contained: no auto-update, telemetry, or side calls.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    // Translation dialects drop thinking blocks; the native one keeps them.
    ...(native ? {} : { CLAUDE_CODE_DISABLE_THINKING: "1" }),
    // Model slugs are unknown to Claude Code's context-window table.
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    // Never inherit a larger user setting than the upstream actually accepts.
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window),
    // Slow upstream: never abort a stream for idling.
    API_FORCE_IDLE_TIMEOUT: "0",
    API_TIMEOUT_MS: "3000000",
  }
}

let resolvedClaude: string | null = null

// Resolve and verify the claude binary. Called before the adapter binds a
// port so a missing binary fails fast with an actionable message.
export async function resolveClaude(): Promise<string> {
  if (resolvedClaude) return resolvedClaude
  const candidate = Bun.which("claude") ?? `${homedir()}/.local/bin/claude`
  if (!(await Bun.file(candidate).exists())) {
    throw new Error(
      `claude executable not found: ${candidate} (check PATH or ~/.local/bin)`,
    )
  }
  resolvedClaude = candidate
  // Read the model catalog out of the binary we are about to launch, so the
  // picker tracks the installed version rather than whatever was current when
  // clgpt shipped. Cached per binary; a failure keeps the built-in fallback.
  await loadCatalog(candidate)
  return candidate
}

// One process-level SIGTERM handler tracking the current child — registering
// per runClaude call would stack handlers whose stale closures can kill a
// newer run.
let currentChild: Bun.Subprocess<"inherit", "inherit", "inherit"> | null = null
let escalateTimer: ReturnType<typeof setTimeout> | undefined
function shutdown(signal: NodeJS.Signals, code: number): void {
  if (!currentChild) process.exit(code) // serve mode: no child to forward to
  try {
    currentChild.kill(signal)
  } catch {
    // already exited
  }
  escalateTimer ??= setTimeout(() => {
    try {
      currentChild?.kill("SIGKILL")
    } catch {
      // already exited
    }
    process.exit(code)
  }, 5000)
}

process.on("SIGTERM", () => shutdown("SIGTERM", 143))
process.on("SIGHUP", () => shutdown("SIGHUP", 129))
process.on("SIGINT", () => shutdown("SIGINT", 130))

// Claude Code's /model lineup. The picker row shape is the one the binary
// validates against: { model, label?, description?, behavesAs? }, plus a
// sibling `replaceBuiltInOptions`. Rows are validated individually — a row
// the binary rejects is dropped with a warning while the rest still apply,
// so depending on `behavesAs` degrades gracefully if the schema changes.
interface PickerOption {
  model: string
  label?: string
  description?: string
  behavesAs?: string
}

interface ModelPicker {
  options: PickerOption[]
  replaceBuiltInOptions: true
}

function routeOf(m: UpstreamModel): string {
  if (m.endpoints.includes("/v1/messages")) return "native"
  if (m.endpoints.includes("/responses")) return "responses"
  return "chat"
}

// ChatGPT's `model_picker_enabled` is VS Code UI metadata, not an
// entitlement — ChatGPT currently returns false for every model, which is why
// filtering on it emptied the lineup entirely. Filter on declared capability
// instead: `capabilities.type` is "chat" for everything you can hold a turn
// with, which drops embeddings and nothing else. Older entries omit both that
// and `supported_endpoints`; ChatGPT serves those over /chat/completions, and
// so does the adapter, so absent metadata must not exclude them.
function conversational(m: UpstreamModel): boolean {
  if (
    m.family &&
    INTERNAL_FAMILIES.has(m.family) &&
    !process.env.CLGPT_SHOW_INTERNAL
  ) {
    return false
  }
  if (m.type) return m.type === "chat"
  if (m.endpoints.length === 0) return true
  return m.endpoints.some((e) => CHAT_ENDPOINTS.includes(e))
}

export function buildModelPickerFrom(
  list: UpstreamModel[],
  opts?: { selected?: string; sessionWindow?: number },
): ModelPicker | null {
  const floor = Number(process.env.CLGPT_MIN_WINDOW ?? "0")
  const usable = list.filter(
    (m) => conversational(m) && (windowOf(m) ?? 0) >= floor,
  )
  const ids = list.map((m) => m.id)
  const selected = opts?.selected ? normalizeModel(opts.selected) : undefined

  const options: PickerOption[] = []
  for (const m of usable) {
    const advertised = advertisedId(m.id)
    // A row whose id Claude Code cannot resolve is silently not offered
    // unless it carries `behavesAs`, so every non-catalog row borrows one.
    const borrowed = advertised ? null : resolveBehavesAs(familyOf(m.id), ids)

    const ctx = windowOf(m)
    // [1m] is the only per-row window channel the schema has, and it is
    // binary: 200k or 1M, nothing between. The real window goes in the
    // description instead.
    const suffix = (ctx ?? 0) >= ONE_MILLION_TOKENS ? "[1m]" : ""
    // Several slugs share one display name (five are "GPT-4o", two are
    // "GPT-5.6 Luna"), so the subtitle leads with the id: it tells the rows
    // apart without cluttering every title with a parenthetical.
    const parts = [m.id, routeOf(m)]
    if (ctx) parts.push(`${Math.round(ctx / 1000)}k`)
    // Claude offers effort tiers to any row with behavesAs; say so where the
    // upstream model will just ignore them.
    if (!m.efforts) parts.push("no effort tiers")
    // Only the shrinking direction is a hazard: the session's auto-compact
    // budget is fixed at launch, so a smaller model can sail past its real
    // limit. A larger one merely leaves headroom unused. Warning on both
    // would mark nearly every row and stop meaning anything.
    if (ctx && opts?.sessionWindow && ctx < opts.sessionWindow) {
      parts.push(`! caps at ${Math.round(ctx / 1000)}k`)
    }
    options.push({
      model: (advertised ?? m.id) + suffix,
      ...(m.name && m.name !== m.id ? { label: m.name } : {}),
      description: parts.join(" · "),
      ...(borrowed ? { behavesAs: borrowed } : {}),
    })
  }

  if (options.length === 0) return null
  options.sort((a, b) => rank(a, list, selected) - rank(b, list, selected))
  // Only ever set with a non-empty lineup: replacing the built-in options
  // while offering none of our own leaves /model completely empty.
  return { options: options.slice(0, 200), replaceBuiltInOptions: true }
}

// Selected model first, then native rows, then widest window first.
function rank(
  o: PickerOption,
  list: UpstreamModel[],
  selected?: string,
): number {
  const id = normalizeModel(o.model)
  if (selected && id === selected) return -1_000_000
  const m = list.find((u) => u.id === id)
  if (!m) return 0
  return (routeOf(m) === "native" ? -100_000 : 0) - (windowOf(m) ?? 0) / 1000
}

function buildModelPicker(selected?: string, sessionWindow?: number) {
  return buildModelPickerFrom(upstreamModels(), { selected, sessionWindow })
}

// The documented channel for "this provider id is really that model": a map
// from the id clgpt advertises to the slug the upstream wants. Where it is
// honoured the adapter receives the upstream slug directly; where it is not,
// translate.ts's alias table catches the same case. They compose.
export function buildModelOverridesFrom(
  list: UpstreamModel[],
): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const m of list) {
    const advertised = advertisedId(m.id)
    if (advertised && advertised !== m.id) out[advertised] = m.id
  }
  return Object.keys(out).length > 0 ? out : null
}

/** What the launch needs, minus anything that touches the filesystem. */
export interface LaunchPlan {
  baseUrl: string
  models: ModelMapping
  defaultModel?: string
  claudeArgs: string[]
  /** The private CLAUDE_CONFIG_DIR, or null when clgpt could not build one. */
  configDir?: string | null
  adapterToken?: string
}

/**
 * The argv clgpt hands claude, as a pure function.
 *
 * Extracted from runClaude so the settings blob can be asserted without
 * spawning a process: the model-pinning bug below was invisible to tests
 * precisely because this was tangled up with Bun.spawn.
 */
export function buildLaunchArgs(plan: LaunchPlan): string[] {
  const userPickedModel = plan.claudeArgs.some(
    (a) => a === "--model" || a.startsWith("--model="),
  )
  const env = buildSettingsEnv(plan.baseUrl, plan.models, plan.defaultModel)
  const picker = buildModelPicker(
    plan.defaultModel ?? plan.models.sonnet,
    Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW),
  )
  const overrides = buildModelOverridesFrom(upstreamModels())
  const configDir = plan.configDir ?? undefined
  // The model rides in the settings blob as well as in --model, because
  // CLAUDE_CONFIG_DIR only moves the USER settings file. Claude Code also
  // reads a PROJECT settings file at ./.claude/settings.json, which the
  // private config dir does not touch - and when the working directory is the
  // home directory those are the same file, so the user's real
  // ~/.claude/settings.json comes back in through the project tier and its
  // `model` key pins the session. Observed: clgpt printed
  // "+ model: gpt-4.1-2025-04-14" while /model reported ".claude/settings.json
  // pins Claude Fable 5.1". The binary's own settings docs say projectSettings
  // and localSettings are repo-controllable and only policy/user/flag settings
  // outrank them, so the --settings tier is the one that wins.
  //
  // Not written into the private settings FILE: that would persist, and a
  // /model pick landing there for good is what the private config dir exists
  // to prevent.
  const settings = JSON.stringify({
    env: { ...env, ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) },
    ...(picker ? { modelPicker: picker } : {}),
    ...(overrides ? { modelOverrides: overrides } : {}),
    ...(userPickedModel || !plan.defaultModel ? {} : { model: plan.defaultModel }),
  })
  // Seeded rather than pinned (see buildSettingsEnv); a --model the user
  // passed themselves always wins.
  const modelArgs =
    userPickedModel || !plan.defaultModel ? [] : ["--model", plan.defaultModel]
  return ["--settings", settings, ...modelArgs, ...plan.claudeArgs]
}

/** The child environment, kept next to the argv it belongs with. */
export function buildLaunchEnv(
  plan: LaunchPlan,
  extraEnv?: Record<string, string>,
): Record<string, string | undefined> {
  const env = buildSettingsEnv(plan.baseUrl, plan.models, plan.defaultModel)
  const configDir = plan.configDir ?? undefined
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...env,
    ...extraEnv,
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
    ...(plan.adapterToken ? { ANTHROPIC_AUTH_TOKEN: plan.adapterToken } : {}),
  }
  // Claude and the browser MCP inherit this environment. Do not accidentally
  // expose a user's API keys or other credentials to either child: clgpt
  // authenticates only through its own per-run local bearer token. Keep normal
  // process settings (PATH, HOME, proxy configuration, etc.) intact.
  const secretName = /(?:^|_)(?:API_KEY|ACCESS_KEY(?:_ID)?|ACCESS_TOKEN|AUTH(?:ORIZATION)?|AUTH_TOKEN|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIALS?|DOCKER_AUTH_CONFIG)(?:$|_)/i
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("CLGPT_") || secretName.test(key)) delete childEnv[key]
  }
  if (plan.adapterToken) childEnv.ANTHROPIC_AUTH_TOKEN = plan.adapterToken
  return childEnv
}

export async function runClaude(opts: {
  baseUrl: string
  models: ModelMapping
  defaultModel?: string
  claudeArgs: string[]
  /** Extra environment the saved setup implies (see setupEnv). */
  extraEnv?: Record<string, string>
  adapterToken?: string
}): Promise<number> {
  const claude = await resolveClaude()
  // Claude persists a /model pick into its config dir. Give it a private one
  // so that write can never reach the user's ~/.claude.
  const configDir = await prepareClaudeHome()
  const plan: LaunchPlan = { ...opts, configDir }
  const launchArgs = buildLaunchArgs(plan)
  const childEnv = buildLaunchEnv(plan, opts.extraEnv)

  const proc = Bun.spawn(
    [claude, ...launchArgs],
    {
      stdio: ["inherit", "inherit", "inherit"],
      env: childEnv,
    },
  )
  currentChild = proc

  const code = await proc.exited
  if (currentChild === proc) {
    currentChild = null
    if (escalateTimer) {
      clearTimeout(escalateTimer)
      escalateTimer = undefined
    }
  }
  return code ?? 0
}
