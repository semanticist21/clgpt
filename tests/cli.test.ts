// The adapter owns a tiny vocabulary; everything dashed belongs to claude and
// bare words are typos that must fail loudly rather than start a session.
import { describe, expect, test } from "bun:test"
import { npmUpdateMessage, parseArgs } from "../src/cli"

test("npm installs have an npm update path", () => {
  expect(npmUpdateMessage()).toContain("npm install --global @semanticist14/clgpt@latest")
})

describe("parseArgs", () => {
  test("dashed flags pass through to claude", () => {
    expect(parseArgs(["--chrome"])).toEqual({
      command: "run",
      port: undefined,
      overrides: {}, claudeArgs: ["--chrome"],
    })
    expect(parseArgs(["-p", "hi"]).claudeArgs).toEqual(["-p", "hi"])
    expect(parseArgs(["--dangerously-skip-permissions"]).claudeArgs).toEqual([
      "--dangerously-skip-permissions",
    ])
  })

  test("adapter commands still win", () => {
    expect(parseArgs(["serve"]).command).toBe("serve")
    expect(parseArgs(["status"]).command).toBe("status")
    expect(parseArgs(["update"]).command).toBe("update")
    expect(parseArgs(["--port", "4141", "--chrome"])).toEqual({
      command: "run",
      port: 4141,
      overrides: {}, claudeArgs: ["--chrome"],
    })
  })

  test("bare typos fail with the command list", () => {
    expect(() => parseArgs(["updaet"])).toThrow(/unknown command/)
    expect(() => parseArgs(["serve", "oops"])).toThrow(/unknown command/)
  })

  test("the launcher sentinel and -- both hand everything to claude", () => {
    expect(parseArgs(["__clgpt_passthrough__", "-p", "hi"]).claudeArgs).toEqual([
      "-p",
      "hi",
    ])
    expect(parseArgs(["--", "--model", "luna-5.6"]).claudeArgs).toEqual([
      "--model",
      "luna-5.6",
    ])
  })
})

describe("parseArgs — setup", () => {
  test("recognises the setup command", () => {
    expect(parseArgs(["setup"]).command).toBe("setup")
  })

  test("consumes --no-* instead of passing it to claude", () => {
    const args = parseArgs(["--no-browser", "--no-bypass", "--no-web"])
    expect(args.overrides).toEqual({ browser: false, bypass: false, web: false })
    expect(args.claudeArgs).toEqual([])
  })

  // The first unknown dashed flag hands everything after it to claude, so the
  // --no-* forms have to be consumed before that point.
  test("keeps claude's own flags intact alongside --no-*", () => {
    const args = parseArgs(["--no-browser", "-p", "hi"])
    expect(args.overrides).toEqual({ browser: false })
    expect(args.claudeArgs).toEqual(["-p", "hi"])
  })
})

describe("parseArgs — version", () => {
  test("recognises the version command", () => {
    expect(parseArgs(["version"]).command).toBe("version")
  })
})
