import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  EXTENSION_URL,
  MCP_PACKAGE,
  browserMcpConfig,
  combinedMcpConfig,
  extensionHint,
  extensionInstalled,
  parseToken,
  probesDefaultRegistry,
  setupNote,
  startupLine,
  startupLine as startupFixture,
} from "../src/browsermcp"
import {
  modelWithoutPrompt,
  setupClaudeArgs,
  setupEnv,
  shouldSelectModel,
} from "../src/setup"
import { tlsHint } from "../src/tls"

// Most cases exercise defaults; exported package overrides belong only in
// the explicit override test. Width fixtures below are built before hooks.
let inheritedPackage: string | undefined
beforeEach(() => {
  inheritedPackage = process.env.CLGPT_MCP_PACKAGE
  delete process.env.CLGPT_MCP_PACKAGE
})
afterEach(() => {
  if (inheritedPackage === undefined) delete process.env.CLGPT_MCP_PACKAGE
  else process.env.CLGPT_MCP_PACKAGE = inheritedPackage
})

const saved = (over: Partial<Record<string, boolean>> = {}) => ({
  version: 2,
  bypass: true,
  select: true,
  browser: false,
  ...over,
})

test("web setup registers both local tools without browser control", () => {
  const config = JSON.parse(combinedMcpConfig(false, true, "gpt-4.1")!)
  expect(config.mcpServers.clgpt_web.args[0]).toContain("webmcp.ts")
  expect(config.mcpServers.clgpt_web.env).toEqual({ CLGPT_WEB_MODEL: "gpt-4.1" })
  expect(setupClaudeArgs(saved({ web: true }), {}, [], false, "gpt-4.1")).toContain("--mcp-config")
  expect(setupClaudeArgs(saved({ web: true }), { web: false }, [], false, "gpt-4.1")).toEqual(["--dangerously-skip-permissions"])
})

describe("setupClaudeArgs", () => {
  test("adds the flags the saved setup implies", () => {
    expect(setupClaudeArgs(saved(), {}, [])).toEqual([
      "--dangerously-skip-permissions",
    ])
  })

  test("adds nothing before setup has ever run", () => {
    expect(setupClaudeArgs(null, {}, [])).toEqual([])
  })

  test("--no-* turns one option off for this run only", () => {
    expect(setupClaudeArgs(saved(), { bypass: false }, [])).toEqual([])
  })

  test("never duplicates a flag the user already passed", () => {
    expect(
      setupClaudeArgs(saved(), {}, ["--dangerously-skip-permissions"]),
    ).toEqual([])
  })

  test("an option saved off stays off", () => {
    expect(setupClaudeArgs(saved({ bypass: false }), {}, [])).toEqual([])
  })
})

describe("shouldSelectModel", () => {
  test("follows the saved answer", () => {
    expect(shouldSelectModel(saved(), {})).toBe(true)
    expect(shouldSelectModel(saved({ select: false }), {})).toBe(false)
  })

  test("--no-select wins over a saved yes", () => {
    expect(shouldSelectModel(saved(), { select: false })).toBe(false)
  })

  // Asking is what clgpt did before setup existed; keep that until answered.
  test("asks when setup has never run", () => {
    expect(shouldSelectModel(null, {})).toBe(true)
  })
})

describe("defaults", () => {
  // The flags people install clgpt for; Enter-through should land on them.
  test("first-run prompts come pre-filled with yes", async () => {
    const { SETUP_DEFAULTS } = await import("../src/setup")
    expect(SETUP_DEFAULTS).toEqual({
      bypass: true,
      select: true,
      browser: true,
      web: true,
    })
  })
})

describe("browser control", () => {
  test("registers the server for the session, without touching MCP config", () => {
    const args = setupClaudeArgs(saved({ browser: true }), {}, [], true)
    const i = args.indexOf("--mcp-config")
    expect(i).toBeGreaterThan(-1)
    const server = JSON.parse(args[i + 1]!).mcpServers.playwright
    // The literal, not the constant - comparing MCP_PACKAGE to itself passes
    // for a typo or an unintended pin just as happily.
    expect(server.args).toContain("@playwright/mcp@0.0.80")
    // Without this the server drives its own browser instead of attaching to
    // the tab the user shared.
    expect(server.args).toContain("--extension")
  })

  // The override exists for people whose network clgpt cannot guess at: an
  // internal mirror, a prefetched version, a rollback past a bad release.
  test("CLGPT_MCP_PACKAGE replaces the spec, and only when set", () => {
    const spec = (config: string | null) =>
      JSON.parse(config!).mcpServers.playwright.args[0]
    expect(spec(browserMcpConfig(true, undefined, "@corp/playwright-mcp@1.2.3")))
      .toBe("@corp/playwright-mcp@1.2.3")
    // The default has to stay the literal default when nothing overrides it -
    // an override that leaked into the unset case would be invisible here
    // otherwise.
    expect(spec(browserMcpConfig(true, undefined))).toBe("@playwright/mcp@0.0.80")
    process.env.CLGPT_MCP_PACKAGE = "@corp/x@1.0.0"
    expect(spec(browserMcpConfig(true, undefined))).toBe("@corp/x@1.0.0")
    expect(setupNote(true)).toContain("@corp/x@1.0.0")
    expect(extensionHint(true)).toContain("@corp/x@1.0.0")
    // And the startup line has to name what actually runs, or "which version
    // was that?" has no answer after a bad release.
    expect(startupLine(true, true, "tok", true, "ok", undefined, "@corp/x@1.0.0"))
      .toBe("+ browser: @corp/x@1.0.0")
  })

  test("rejects credential-bearing package URLs before placing them in argv", () => {
    expect(() => browserMcpConfig(true, undefined, "https://user:secret@example.com/mcp.tgz"))
      .toThrow(/must not contain URL credentials/)
    expect(() => browserMcpConfig(true, undefined, "https://example.com/mcp.tgz?token=secret"))
      .toThrow(/must not contain URL credentials/)
    expect(() => browserMcpConfig(true, undefined, "@corp/mcp@https://user:secret@example.com/mcp.tgz"))
      .toThrow(/must not contain URL credentials/)
  })

  // The extension is the half clgpt cannot install; registering the server
  // alone would surface tools that fail on every call.
  test("registers nothing when the extension is missing", () => {
    expect(setupClaudeArgs(saved({ browser: true }), {}, [], false)).not.toContain(
      "--mcp-config",
    )
    expect(browserMcpConfig(false)).toBeNull()
  })

  test("--no-browser skips it for one run", () => {
    expect(
      setupClaudeArgs(saved({ browser: true }), { browser: false }, [], true),
    ).not.toContain("--mcp-config")
  })

  // A user-supplied --mcp-config owns the session's MCP set; adding a second
  // one silently would change what they asked for.
  test("defers to an --mcp-config the user passed", () => {
    expect(
      setupClaudeArgs(saved({ browser: true }), {}, ["--mcp-config", "x.json"], true),
    ).not.toContain("--mcp-config")
  })

  test("reports the extension without probing the network", async () => {
    // The server is spawned per conversation, so nothing listens at startup;
    // detection has to be filesystem-based to avoid a false negative.
    expect(await extensionInstalled("/nonexistent-home")).toBe(false)
    expect(extensionHint(false)).toContain("chromewebstore.google.com")
    expect(extensionHint(true)).toContain("found")
  })
})

describe("extension token", () => {
  const withToken = { ...saved({ browser: true }), browserToken: "tok123" }
  // setupEnv reads this variable, and it is the one clgpt tells users to
  // export - without isolating it the suite fails for anyone who followed
  // that advice, and passes here only by accident.
  const KEY = "PLAYWRIGHT_MCP_EXTENSION_TOKEN"
  let saved_env: string | undefined
  beforeEach(() => {
    saved_env = process.env[KEY]
    delete process.env[KEY]
  })
  afterEach(() => {
    if (saved_env === undefined) delete process.env[KEY]
    else process.env[KEY] = saved_env
  })

  test("is passed to the child so sessions skip the connect dialog", () => {
    expect(setupEnv(withToken, {})).toEqual({})
  })

  test("an exported value wins over the stored one", () => {
    process.env[KEY] = "from-shell"
    expect(setupEnv(withToken, {})).toEqual({})
  })

  test("nothing to pass without a token, or with browser off for the run", () => {
    expect(setupEnv(saved({ browser: true }), {})).toEqual({})
    expect(setupEnv(withToken, { browser: false })).toEqual({})
    expect(setupEnv(null, {})).toEqual({})
  })

  // Connection itself cannot be known at startup, so the hint reports the
  // token instead - it is what decides whether a dialog appears.
  test("the hint distinguishes stored token from none", () => {
    expect(extensionHint(true, "tok")).toContain("without the connect dialog")
    expect(extensionHint(true)).toContain("connect dialog")
    expect(extensionHint(true)).toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN")
  })
})

describe("token parsing", () => {
  const want = "vsniGjCK1P0voIepAYLL_hVbDXq_tgzoHjH5aFa8Ffk"

  // The extension displays the whole assignment, so that is what gets pasted.
  test("accepts the value, the assignment, or an exported line", () => {
    for (const input of [
      want,
      `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${want}`,
      `export PLAYWRIGHT_MCP_EXTENSION_TOKEN=${want}`,
      `  PLAYWRIGHT_MCP_EXTENSION_TOKEN="${want}"  `,
      `PLAYWRIGHT_MCP_EXTENSION_TOKEN='${want}'`,
    ]) {
      expect(parseToken(input)).toBe(want)
    }
  })

  // A terminal submits at the first newline, so a multi-line paste would
  // otherwise store whichever line happened to come first.
  test("picks the token line out of a multi-line paste", () => {
    expect(parseToken(`Set this to bypass the dialog:\nPLAYWRIGHT_MCP_EXTENSION_TOKEN=${want}\n`))
      .toBe(want)
    expect(parseToken(`${want}\nkkomi@host ~ % clgpt setup`)).toBe(want)
  })

  // The shape check is what stopped a pasted shell prompt being saved as a
  // token that could never work, with nothing to explain why.
  test("rejects input that is not a token", () => {
    expect(parseToken("kkomi@semanticist ~ % clgpt setup")).toBeNull()
    expect(parseToken("no")).toBeNull()
  })

  test("treats an empty answer as skipped", () => {
    expect(parseToken("")).toBeUndefined()
    expect(parseToken("   ")).toBeUndefined()
    expect(parseToken("PLAYWRIGHT_MCP_EXTENSION_TOKEN=")).toBeUndefined()
  })
})

describe("startup line", () => {
  test("reports what clgpt did, and whether a dialog is coming", () => {
    expect(startupLine(true, true, "tok", true)).toBe("+ browser: @playwright/mcp@0.0.80")
    expect(startupLine(true, true, undefined, true)).toContain("connect dialog each session")
    // Spread over lines on purpose: the URL must START a line to survive an
    // 80-column terminal. Wrapped mid-URL it can be neither clicked nor
    // copied, which is how a required install step went unnoticed.
    const missing = startupLine(true, false)!
    expect(missing).toContain("not installed in Chrome")
    expect(missing).toContain("only you can add it")
    const urlLine = missing.split("\n").find((l) => l.includes("chromewebstore"))!
    expect(urlLine.trim()).toBe(EXTENSION_URL)
    expect(urlLine.length).toBeLessThanOrEqual(78)
  })

  // Nothing to say when browser control is off, or off for this run.
  test("stays quiet when the feature is not in play", () => {
    expect(startupLine(false, true, "tok")).toBeNull()
  })
})

describe("browser MCP under a TLS-inspecting proxy", () => {
  // npx fetches from the npm registry over its own TLS, outside clgpt's
  // openaiFetch, so without this the browser feature is the one part that
  // still fails on the network the CA work exists for.
  test("hands the corporate CA down to the MCP child", () => {
    const server = JSON.parse(browserMcpConfig(true, "/tmp/ca.pem")!)
      .mcpServers.playwright
    expect(server.env).toMatchObject({ NODE_EXTRA_CA_CERTS: "/tmp/ca.pem" })
    expect(server.env.CLGPT_MCP_PREFS_PATH).toContain("prefs.json")
  })

  // null, not undefined - undefined selects the process.env default, so this
  // asserted the developer's own environment rather than the intended input.
  test("sets no env when neither a CA nor a token is configured", () => {
    expect(JSON.parse(browserMcpConfig(true, null)!).mcpServers.playwright.env)
      .toMatchObject({ CLGPT_MCP_PREFS_PATH: expect.stringContaining("prefs.json") })
  })

  // This object becomes an --mcp-config argv element, and argv is readable by
  // other local users. The token travels through claude's environment, which
  // MCP children inherit, so it must never appear here.
  test("keeps the extension token out of argv", () => {
    const config = browserMcpConfig(true, "/tmp/ca.pem")!
    expect(config).not.toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN")
    const args = setupClaudeArgs(
      { ...saved({ browser: true }), browserToken: "SECRET" },
      {},
      [],
      true,
    )
    expect(args.join(" ")).not.toContain("SECRET")
    // ...while still reaching the server by the route that is not public.
    expect(setupEnv({ ...saved({ browser: true }), browserToken: "SECRET" }, {}))
      .toEqual({})
  })

  // The installer guarantees bun, not Node, while startupLine would otherwise
  // report success for a server that cannot spawn.
  // clgpt already runs under bun, so bunx is there; requiring Node as well was
  // an extra dependency for nothing.
  test("runs the server with bunx where it exists", () => {
    const server = JSON.parse(browserMcpConfig(true)!).mcpServers.playwright
    expect(server.command.endsWith("scripts/playwright-wrapper.sh")).toBe(true)
  })

  test("says so when no runner exists at all", () => {
    expect(startupLine(true, true, "tok", false)).toContain("neither bunx nor npx")
  })
})

describe("prefs merging", () => {
  // The model prompt wrote { last_model } and the setup answers went with it,
  // so choosing a model reset the wizard - observed on a live install.
  test("writing one concern does not erase another", async () => {
    const { loadPrefs, savePrefs, setConfigDir } = await import("../src/config")
    const dir = join(tmpdir(), `clgpt-prefs-${Date.now()}`)
    setConfigDir(dir)
    try {
      await savePrefs({
        setup: { version: 2, bypass: true, select: true, browser: true },
      })
      await savePrefs({ last_model: "kimi-k3" })
      const after = await loadPrefs()
      expect(after.last_model).toBe("kimi-k3")
      expect(after.setup?.browser).toBe(true)
    } finally {
      setConfigDir(null)
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("token clearing", () => {
  // Merging made this the one path that has to delete rather than add, and
  // it works only because the caller spreads the whole setup object.
  test("--clear removes the key from the file on disk", async () => {
    const { loadPrefs, savePrefs, setConfigDir } = await import("../src/config")
    const dir = join(tmpdir(), `clgpt-clear-${Date.now()}`)
    setConfigDir(dir)
    try {
      await savePrefs({
        setup: { version: 2, bypass: true, select: true, browser: true, browserToken: "tok" },
      })
      expect((await loadPrefs()).setup?.browserToken).toBe("tok")
      const prefs = await loadPrefs()
      await savePrefs({ setup: { ...prefs.setup!, browserToken: undefined } })
      const raw = await readFile(join(dir, "prefs.json"), "utf8")
      expect(raw).not.toContain("browserToken")
      expect((await loadPrefs()).setup?.bypass).toBe(true)
    } finally {
      setConfigDir(null)
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("registry reachability", () => {
  // The server is fetched at session start, so on a network that blocks npm
  // it never starts - and that failure would otherwise appear only as an MCP
  // error inside claude, while clgpt's startup line claimed success.
  test("says so instead of claiming success", () => {
    expect(startupLine(true, true, "tok", true, "blocked")).toContain(
      "cannot reach registry.npmjs.org",
    )
    // A re-signed certificate is a different problem with a different fix, and
    // reporting it as "unreachable" sends the user looking at their firewall.
    const tls = startupLine(true, true, "tok", true, "tls", undefined, undefined, false)!
    expect(tls).toContain("TLS rejected")
    expect(tls).toContain("Set CLGPT_CA_BUNDLE")
    expect(startupLine(true, true, "tok", true, "ok")).toBe(
      "+ browser: @playwright/mcp@0.0.80",
    )
    // The host answered and the dates failed, so neither "cannot reach" nor a
    // CA is the right answer.
    const expired = startupLine(true, true, "tok", true, "expired")!
    expect(expired).toContain("expired certificate")
    expect(expired).toContain("No CA file fixes this")
    // A slow proxy is not a verdict: the bunx inside claude has no 2.5s
    // budget, so predicting that tools "will not appear" would be wrong.
    const slow = startupLine(true, true, "tok", true, "slow")!
    expect(slow).toContain("is slow to answer")
    expect(slow).toContain("may be slow")
    // Not checked is not the same as unreachable.
    expect(startupLine(true, true, "tok", true, undefined)).toBe(
      "+ browser: @playwright/mcp@0.0.80",
    )
  })

  // A missing runner is the more basic problem and should be named first.
  test("reports a missing runner ahead of the registry", () => {
    expect(startupLine(true, true, "tok", false, "blocked")).toContain("neither bunx nor npx")
  })
})

describe("startup line honesty", () => {
  // clgpt stands aside when the user passes their own --mcp-config, and
  // claiming success there is the same trap as registering a server with no
  // extension: a promise with nothing behind it.
  test("says it stood aside rather than claiming success", () => {
    expect(startupLine(true, true, "tok", true, undefined, false)).toContain(
      "your own --mcp-config takes over",
    )
    expect(startupLine(true, true, "tok", true, "ok", true)).toBe(
      "+ browser: @playwright/mcp@0.0.80",
    )
  })
})

describe("model when the prompt is off", () => {
  const offered = ["claude-sonnet-5", "gpt-4.1-2025-04-14"]

  // Answering no to "pick a model each time" used to pass no --model at all,
  // so claude fell back to its own newest built-in and every launch started on
  // Fable - a model the user had never chosen.
  test("reuses the remembered pick", () => {
    expect(
      modelWithoutPrompt("gpt-4.1-2025-04-14", offered, "claude-sonnet-5"),
    ).toBe("gpt-4.1-2025-04-14")
  })

  // Never picked one, or picked one this account no longer offers: the slot
  // clgpt advertises on its startup line is the honest answer.
  test("falls back to the sonnet slot", () => {
    expect(modelWithoutPrompt(undefined, offered, "claude-sonnet-5")).toBe(
      "claude-sonnet-5",
    )
    expect(modelWithoutPrompt("kimi-k3", offered, "claude-sonnet-5")).toBe(
      "claude-sonnet-5",
    )
  })

  // discoverModels caches the model list before deciding it found no
  // claude-sonnet slug, so a plan without Claude models reaches here with a
  // non-empty list and a sonnet slot that is only a guess. Asserting that as
  // --model would break a session that previously worked by passing nothing.
  test("passes nothing when even the fallback is not served", () => {
    expect(
      modelWithoutPrompt(undefined, ["mock-chat"], "claude-sonnet-4.5"),
    ).toBeUndefined()
    expect(
      modelWithoutPrompt("kimi-k3", ["mock-chat"], "claude-sonnet-4.5"),
    ).toBeUndefined()
    // Nothing offered at all is the same answer, not a crash.
    expect(modelWithoutPrompt("kimi-k3", [], "claude-sonnet-5")).toBeUndefined()
  })
})

// Telling someone to set a variable they already set is the advice this line
// exists to avoid giving.
describe("TLS advice adapts to what is already configured", () => {
  // Keyed on whether a bundle LOADED, not on whether the variable is set: an
  // unreadable path leaves it set and loads nothing, and claiming the bundle
  // does not cover the chain would then point away from the real fix.
  test("names the configured bundle as insufficient instead", () => {
    const line = startupLine(true, true, "tok", true, "tls", undefined, undefined, true)!
    expect(line).toContain("does not cover this chain")
    expect(line).not.toContain("Set CLGPT_CA_BUNDLE")
  })
})

// The probe only knows registry.npmjs.org. A spec pointing elsewhere is not
// probed, and a bare "+" there would assert a check that never ran.
describe("a package clgpt cannot probe", () => {
  test("says the check did not run", () => {
    const line = startupLine(
      true, true, "tok", true, undefined, undefined, "@corp/mcp@1.2.3",
    )!
    // Folded, because the verdict and the reason together do not fit 80
    // columns and a terminal-wrapped line breaks mid-word.
    expect(line.split("\n").every((l) => l.length <= 76)).toBe(true)
    expect(line.replace(/\n\s+/g, " ")).toBe(
      "+ browser: @corp/mcp@1.2.3 (not the default package, so the registry check was skipped)",
    )
  })

  // Two same-shaped parentheticals in a row read as unrelated afterthoughts on
  // the line that is meant to be clgpt's clearest summary.
  test("merges into one parenthetical when the token is missing too", () => {
    const both = startupLine(
      true, true, undefined, true, undefined, undefined, "@corp/mcp@1.2.3",
    )!
    expect(both.split("\n").every((l) => l.length <= 76)).toBe(true)
    expect(both.replace(/\n\s+/g, " ")).toBe(
      "+ browser: @corp/mcp@1.2.3 (not the default package, so the registry" +
        " check was skipped; connect dialog each session)",
    )
  })

  // A file:/link: version needs no registry at all, so probing npmjs and
  // predicting "browser tools will not appear" would be about nothing.
  test("a local version is not a registry spec", () => {
    expect(probesDefaultRegistry("@playwright/mcp@file:/opt/local-mcp")).toBe(false)
    expect(probesDefaultRegistry("@playwright/mcp@link:../mcp")).toBe(false)
  })

  // lastIndexOf returns -1 with no "@" and slice(0, -1) then drops the last
  // character, which only stayed harmless because MCP_PACKAGE is scoped.
  test("a spec with no version keeps its whole name", () => {
    expect(probesDefaultRegistry("@playwright/mcp")).toBe(true)
    expect(probesDefaultRegistry("playwright-mcp")).toBe(false)
    expect(probesDefaultRegistry("@playwright/mcp-fork@1.0.0")).toBe(false)
  })

  // A pin or a rollback still comes from npmjs, so the check is as truthful as
  // it is by default and must not be skipped.
  test("a pinned version is still probed", () => {
    expect(probesDefaultRegistry("@playwright/mcp@0.0.80")).toBe(true)
    expect(probesDefaultRegistry("@playwright/mcp@0.0.80")).toBe(true)
    expect(probesDefaultRegistry("@corp/playwright-mcp@1.2.3")).toBe(false)
    expect(
      startupLine(true, true, "tok", true, "ok", undefined, "@playwright/mcp@0.0.80"),
    ).toBe("+ browser: @playwright/mcp@0.0.80")
  })
})

// CLGPT_CA_BUNDLE takes several paths and clgpt unions them in-process, but
// NODE_EXTRA_CA_CERTS names one file - so forwarding the raw value made clgpt's
// own probe pass while the child still could not fetch.
describe("CA bundle handed to the MCP child", () => {
  const envOf = (config: string | null) =>
    JSON.parse(config!).mcpServers.playwright.env as
      | Record<string, string>
      | undefined

  test("forwards a single absolute path", () => {
    expect(envOf(browserMcpConfig(true, "/a/ca.pem:/b/ca.pem"))!.NODE_EXTRA_CA_CERTS)
      .toBe("/a/ca.pem")
    // Relative resolves against the child's cwd, not clgpt's.
    expect(
      envOf(browserMcpConfig(true, "ca.pem"))!.NODE_EXTRA_CA_CERTS,
    ).toStartWith("/")
  })

  // null, not undefined: undefined selects the process.env default, so this
  // test used to fail for anyone who actually had CLGPT_CA_BUNDLE exported -
  // exactly the users the feature exists for.
  test("no CA means no env block at all", () => {
    expect(JSON.parse(browserMcpConfig(true, null)!).mcpServers.playwright.env)
      .toMatchObject({ CLGPT_MCP_PREFS_PATH: expect.stringContaining("prefs.json") })
  })

  // caPaths() is shared with clgpt's own bundle loading, so a padded or ~-based
  // value cannot mean one thing in-process and another in the child.
  test("trims and expands the way clgpt's own loader does", () => {
    expect(envOf(browserMcpConfig(true, " /a/ca.pem "))!.NODE_EXTRA_CA_CERTS).toBe(
      "/a/ca.pem",
    )
    expect(envOf(browserMcpConfig(true, "~/ca.pem"))!.NODE_EXTRA_CA_CERTS).toBe(
      `${homedir()}/ca.pem`,
    )
  })
})

// A terminal wraps a long line mid-word and mid-URL. That is how the browser
// extension step went unread: its URL broke across two lines, so it could be
// neither clicked nor copied, and copying it landed on the Web Store home
// page. Every status line and note clgpt can print is measured here so the
// class cannot come back one string at a time.
describe("nothing clgpt prints overflows an 80-column terminal", () => {
  // 76, not 80: a clack note box adds two columns of frame on each side.
  const LIMIT = 76
  const lines = (text: string | null) => (text ?? "").split("\n")

  const startupLine = (
    enabled: boolean, installed: boolean, token?: string, hasRunner = true,
    registry?: Parameters<typeof startupFixture>[4], registered?: boolean,
    pkg = "@playwright/mcp@0.0.80", caLoaded = false,
  ) => startupFixture(enabled, installed, token, hasRunner, registry, registered, pkg, caLoaded)
  const everything: Array<[string, string | null]> = [
    ["no extension", startupLine(true, false)],
    ["no runner", startupLine(true, true, "t", false)],
    ["stood aside", startupLine(true, true, "t", true, undefined, false)],
    ["tls, no bundle", startupLine(true, true, "t", true, "tls", undefined, undefined, false)],
    ["tls, bundle", startupLine(true, true, "t", true, "tls", undefined, undefined, true)],
    ["expired", startupLine(true, true, "t", true, "expired")],
    ["blocked", startupLine(true, true, "t", true, "blocked")],
    ["slow", startupLine(true, true, "t", true, "slow")],
    ["ok", startupLine(true, true, "t", true, "ok")],
    ["ok, no token", startupLine(true, true, undefined, true, "ok")],
    ["other package", startupLine(true, true, undefined, true, undefined, undefined, "@corp/mcp@9.9.9")],
    ["setup note, missing", setupNote(false, "@playwright/mcp@0.0.80")],
    ["setup note, present", setupNote(true, "@playwright/mcp@0.0.80")],
    ["hint, missing", extensionHint(false, undefined, "@playwright/mcp@0.0.80")],
    ["hint, no token", extensionHint(true, undefined, "@playwright/mcp@0.0.80")],
    ["hint, token", extensionHint(true, "tok", "@playwright/mcp@0.0.80")],
    ["tls hint, no bundle", tlsHint(false)],
    ["tls hint, bundle", tlsHint(true)],
  ]

  test.each(everything)("%s fits", (_name, text) => {
    for (const line of lines(text)) expect(line.length).toBeLessThanOrEqual(LIMIT)
  })

  // The URL is the one string where wrapping is not merely ugly: a broken URL
  // is a dead link. It must start its own line everywhere it appears.
  test.each(everything)("%s keeps any URL whole", (_name, text) => {
    for (const line of lines(text)) {
      if (!line.includes("chromewebstore")) continue
      expect(line.trim()).toBe(EXTENSION_URL)
    }
  })
})
