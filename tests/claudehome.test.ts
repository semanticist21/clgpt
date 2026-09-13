import { describe, expect, test } from "bun:test"
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { prepareClaudeHome, readFastModePreference } from "../src/claudehome"

const run = (home: string) => prepareClaudeHome(home)

describe("prepareClaudeHome", () => {
  test("shares behaviour, privatises what claude writes", async () => {
    const home = join(tmpdir(), `clgpt-home-${Date.now()}`)
    const real = join(home, ".claude")
    await mkdir(join(real, "skills"), { recursive: true })
    await writeFile(join(real, "CLAUDE.md"), "# shared\n")
    // A leftover ChatGPT slug must not be carried into the private copy.
    await writeFile(
      join(real, "settings.json"),
      // A provider env block (here: z.ai's) must lose its auth and routing
      // keys in the copy, or claude sends that token instead of clgpt's.
      JSON.stringify({
        model: "gpt-4.1",
        env: {
          KEEP: "1",
          ANTHROPIC_AUTH_TOKEN: "zai-token",
          ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
          ANTHROPIC_API_KEY: "zai-key",
          API_TIMEOUT_MS: "600000",
        },
      }),
    )
    await writeFile(join(home, ".claude.json"), JSON.stringify({ trusted: true }))

    const dir = await run(home)
    expect(dir).not.toBeNull()

    // Behaviour-shaping entries stay live links to the real tree.
    expect((await lstat(join(dir!, "skills"))).isSymbolicLink()).toBe(true)
    expect((await lstat(join(dir!, "CLAUDE.md"))).isSymbolicLink()).toBe(true)

    // settings.json is a real file, so claude's write lands here, and the
    // stale model key is dropped rather than seeding the next session.
    const settings = JSON.parse(
      await readFile(join(dir!, "settings.json"), "utf8"),
    )
    expect((await lstat(join(dir!, "settings.json"))).isSymbolicLink()).toBe(false)
    expect((await lstat(dir!)).mode & 0o777).toBe(0o700)
    expect((await lstat(join(dir!, ".claude.json"))).mode & 0o777).toBe(0o600)
    expect((await lstat(join(dir!, "settings.json"))).mode & 0o777).toBe(0o600)
    expect(settings.model).toBeUndefined()
    expect(settings.env).toEqual({ KEEP: "1", API_TIMEOUT_MS: "600000" })

    // Writing through the private dir must never reach the user's file.
    await writeFile(
      join(dir!, "settings.json"),
      JSON.stringify({ model: "kimi-k3" }),
    )
    const userSettings = JSON.parse(
      await readFile(join(real, "settings.json"), "utf8"),
    )
    expect(userSettings.model).toBe("gpt-4.1")

    // Trust and MCP state is seeded once, then owned by clgpt.
    expect(JSON.parse(await readFile(join(dir!, ".claude.json"), "utf8"))).toEqual({
      trusted: true,
    })
    await writeFile(join(dir!, ".claude.json"), JSON.stringify({ trusted: false }))
    await run(home)
    expect(JSON.parse(await readFile(join(dir!, ".claude.json"), "utf8"))).toEqual({
      trusted: false,
    })

    // A newly added entry shows up without any cache to clear.
    await writeFile(join(real, "later.md"), "x")
    await run(home)
    expect(await readdir(dir!)).toContain("later.md")

    await rm(home, { recursive: true, force: true })
  })

  // Returning null hands the child the user's own ~/.claude, where a /model
  // pick persists - and the snapshot/restore that used to cover that is gone.
  // A missing ~/.claude is no reason to give that up; the private dir works
  // fine empty.
  test("isolates even when there is no ~/.claude to mirror", async () => {
    const home = join(tmpdir(), `clgpt-empty-${Date.now()}`)
    await mkdir(home, { recursive: true })
    const dir = await run(home)
    expect(dir).not.toBeNull()
    expect((await lstat(dir!)).isDirectory()).toBe(true)
    await rm(home, { recursive: true, force: true })
  })

  test("drops a link whose source is gone, and re-points a stale one", async () => {
    const home = join(tmpdir(), `clgpt-stale-${Date.now()}`)
    const real = join(home, ".claude")
    await mkdir(join(real, "skills"), { recursive: true })
    await writeFile(join(real, "temp.md"), "x")
    const dir = (await run(home))!
    expect(await readdir(dir)).toContain("temp.md")

    // Source removed: the link would otherwise dangle here forever.
    await rm(join(real, "temp.md"))
    await run(home)
    expect(await readdir(dir)).not.toContain("temp.md")

    // A link left pointing at a previous $HOME was trusted unconditionally.
    await rm(join(dir, "skills"))
    await symlink("/nonexistent/skills", join(dir, "skills"))
    await run(home)
    expect(await readlink(join(dir, "skills"))).toBe(join(real, "skills"))

    await rm(home, { recursive: true, force: true })
  })

  // A line-based strip broke this three ways: it left a dangling comma when
  // `model` was the last key, reached `model` nested in other objects, and
  // missed it when it shared a line with another key.
  test("strips only the top-level model key, and leaves valid JSON", async () => {
    const cases: Array<[string, string]> = [
      ["last key", '{\n  // c\n  "env": { "A": "1" },\n  "model": "gpt-4.1"\n}'],
      ["shares a line", '{ "model": "gpt-4.1", "env": { "A": "1" } }'],
      ["nested model stays", '{\n  "model": "gpt-4.1",\n  "env": { "model": "keep" }\n}'],
      ["trailing comma", '{\n  "model": "gpt-4.1",\n  "env": { "A": "1" },\n}'],
    ]
    for (const [name, body] of cases) {
      const home = join(tmpdir(), `clgpt-jsonc-${Date.now()}-${name.replace(/ /g, "")}`)
      const real = join(home, ".claude")
      await mkdir(real, { recursive: true })
      await writeFile(join(real, "settings.json"), body)
      const dir = (await run(home))!
      const out = await readFile(join(dir, "settings.json"), "utf8")
      const parsed = JSON.parse(out) as Record<string, unknown>
      expect(parsed.model).toBeUndefined()
      expect(parsed.env).toBeDefined()
      if (name === "nested model stays") {
        expect((parsed.env as Record<string, unknown>).model).toBe("keep")
      }
      await rm(home, { recursive: true, force: true })
    }
  })

  // Replacing an unparseable file with something broken would lose every
  // setting; keeping the previous copy at least keeps the session working.
  test("keeps the previous copy when neither form parses", async () => {
    const home = join(tmpdir(), `clgpt-broken-${Date.now()}`)
    const real = join(home, ".claude")
    await mkdir(real, { recursive: true })
    await writeFile(join(real, "settings.json"), '{ "env": ')
    const dir = (await run(home))!
    await writeFile(join(dir, "settings.json"), '{"kept":true}')
    await run(home)
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).kept).toBe(true)
    await rm(home, { recursive: true, force: true })
  })

  // With no global settings.json the private copy was never rewritten, so a
  // slug claude wrote there in an earlier session survived every launch.
  test("strips a stale model key even with no global settings.json", async () => {
    const home = join(tmpdir(), `clgpt-nosettings-${Date.now()}`)
    await mkdir(join(home, ".claude"), { recursive: true })
    const dir = (await run(home))!
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ model: "kimi-k3", outputStyle: "keep-me" }),
    )
    await run(home)
    const after = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"))
    expect(after.model).toBeUndefined()
    expect(after.outputStyle).toBe("keep-me")
    await rm(home, { recursive: true, force: true })
  })

  test("every private entry stays a real file, never a link back", async () => {
    const home = join(tmpdir(), `clgpt-private-${Date.now()}`)
    const real = join(home, ".claude")
    await mkdir(join(real, "backups"), { recursive: true })
    await writeFile(join(real, "settings.json"), "{}")
    await writeFile(join(real, "settings.local.json"), "{}")
    const dir = (await run(home))!
    for (const name of ["settings.json", "settings.local.json", "backups"]) {
      const s = await lstat(join(dir, name)).catch(() => null)
      expect(s?.isSymbolicLink() ?? false).toBe(false)
    }
    await rm(home, { recursive: true, force: true })
  })
})

describe("readFastModePreference", () => {
  test("reads a boolean preference and ignores malformed or absent settings", async () => {
    const home = join(tmpdir(), `clgpt-fast-${Date.now()}`)
    await mkdir(home, { recursive: true })
    await writeFile(join(home, "settings.json"), '{ "fastMode": true }')
    expect(await readFastModePreference(home)).toBe(true)
    await writeFile(join(home, "settings.json"), '{ "fastMode": "yes" }')
    expect(await readFastModePreference(home)).toBeUndefined()
    await writeFile(join(home, "settings.json"), "not json")
    expect(await readFastModePreference(home)).toBeUndefined()
    await rm(home, { recursive: true, force: true })
  })
})

describe("comma handling", () => {
  // A regex over the whole document ate commas inside string values; a
  // permission rule is the realistic carrier, and altering one changes what
  // claude is allowed to do.
  test("keeps commas inside strings, drops only trailing ones", async () => {
    const home = join(tmpdir(), `clgpt-comma-${Date.now()}`)
    const real = join(home, ".claude")
    await mkdir(real, { recursive: true })
    await writeFile(
      join(real, "settings.json"),
      '{\n  // c\n  "model": "x",\n  "permissions": { "allow": ["Bash(awk \'{print $1,}\')"] },\n}',
    )
    const dir = (await run(home))!
    const parsed = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"))
    expect(parsed.permissions.allow[0]).toBe("Bash(awk '{print $1,}')")
    expect(parsed.model).toBeUndefined()
    await rm(home, { recursive: true, force: true })
  })
})

describe("project trust", () => {
  // clgpt sessions record trust in the private config dir, so a project only
  // ever opened through clgpt never appears in the real file. Treating absent
  // as "withdrawn" re-asked the trust question on every single launch.
  test("absent from the real file means no opinion, not withdrawn", async () => {
    const home = join(tmpdir(), `clgpt-trust-${Date.now()}`)
    await mkdir(join(home, ".claude"), { recursive: true })
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { "/other": { hasTrustDialogAccepted: true } } }),
    )
    const dir = (await run(home))!
    const priv = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8"))
    priv.projects["/clgpt-only"] = { hasTrustDialogAccepted: true }
    await writeFile(join(dir, ".claude.json"), JSON.stringify(priv))
    await run(home)
    const after = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8"))
    expect(after.projects["/clgpt-only"].hasTrustDialogAccepted).toBe(true)
  })

  // ...while a project the real file does know about still follows it.
  test("an explicit false in the real file does propagate", async () => {
    const home = join(tmpdir(), `clgpt-untrust-${Date.now()}`)
    await mkdir(join(home, ".claude"), { recursive: true })
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { "/p": { hasTrustDialogAccepted: true } } }),
    )
    const dir = (await run(home))!
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { "/p": { hasTrustDialogAccepted: false } } }),
    )
    await run(home)
    const after = JSON.parse(await readFile(join(dir, ".claude.json"), "utf8"))
    expect(after.projects["/p"].hasTrustDialogAccepted).toBe(false)
    await rm(home, { recursive: true, force: true })
  })
})
