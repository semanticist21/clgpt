import { describe, expect, test } from "bun:test"
import { caPaths, isCertValidityError, isTlsTrustError } from "../src/tls"
import { homedir } from "node:os"
import { registryStatus } from "../src/browsermcp"

// These are the literal messages and codes Bun's fetch produces, measured
// against local TLS servers built with openssl-minted certs. The predicate
// used to be a regex over the message alone, and it silently missed the third
// row - a proxy presenting a leaf without shipping its intermediate, which is
// the most ordinary corporate shape there is. That failure was reported as an
// unreachable host, so the user was sent to their firewall team instead of
// being told to set CLGPT_CA_BUNDLE. Nothing tested this predicate at all,
// which is why it stayed missed.
describe("isTlsTrustError", () => {
  const trust: Array<[string, string]> = [
    ["self signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT"],
    ["self signed certificate in certificate chain", "SELF_SIGNED_CERT_IN_CHAIN"],
    ["unable to verify the first certificate", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
    ["unable to get local issuer certificate", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"],
  ]

  test.each(trust)("%s is a trust failure", (message, code) => {
    expect(isTlsTrustError(Object.assign(new Error(message), { code }))).toBe(true)
    // The code is the reliable signal, so it has to win on its own - a future
    // Bun could reword any of these messages.
    expect(isTlsTrustError(Object.assign(new Error("something else"), { code }))).toBe(
      true,
    )
    // And the message has to still work alone: server.ts and cli.ts stringify.
    expect(isTlsTrustError(message)).toBe(true)
  })

  // Reaching for the CA here would be wrong advice: nothing about the chain
  // failed.
  test.each([
    ["The operation timed out.", "TimeoutError"],
    ["Unable to connect. Is the computer able to access the url?", "ConnectionRefused"],
    ["Failed to lookup host", "DNS_ENOTFOUND"],
  ])("%s is not a trust failure", (message, code) => {
    expect(isTlsTrustError(Object.assign(new Error(message), { code }))).toBe(false)
  })

  // Bun nests the real cause on some fetch failures.
  test("looks through cause", () => {
    const inner = Object.assign(new Error("self signed certificate"), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    })
    expect(isTlsTrustError(Object.assign(new Error("fetch failed"), { cause: inner }))).toBe(
      true,
    )
  })
})

// The mapping from a failed probe to a word the user reads was the substance
// of the change and had no test: the rendering tests were fed a status that
// had already been decided.
describe("registryStatus", () => {
  test("a refused connection is blocked, not a TLS problem", async () => {
    // Port 1 with nothing on it: refused, not re-signed.
    expect(await registryStatus(2500, "https://127.0.0.1:1/probe")).toBe("blocked")
  })

  // A socket that accepts and never answers, so the verdict comes from the
  // budget rather than from the network. An earlier version dialled a
  // non-routable address and depended on it black-holing; behind a proxy that
  // rejects immediately the same call returns "blocked" and the test flipped.
  test("a timeout is its own answer", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {} },
    })
    try {
      expect(
        await registryStatus(50, `http://127.0.0.1:${server.port}/probe`),
      ).toBe("slow")
    } finally {
      server.stop(true)
    }
  })
})

// A hostname mismatch verifies the chain and fails on the name, so no CA can
// fix it - and saying otherwise sent the user to export a certificate that
// could not help.
describe("what is not a trust failure", () => {
  // A lapsed proxy certificate is an ordinary corporate failure. No CA fixes
  // it, so it is not a trust error - but the host answered, so reporting it as
  // unreachable sent the user to their firewall team.
  test.each([
    ["certificate has expired", "CERT_HAS_EXPIRED"],
    ["certificate is not yet valid", "CERT_NOT_YET_VALID"],
  ])("%s is validity, not trust", (message, code) => {
    const err = Object.assign(new Error(message), { code })
    expect(isTlsTrustError(err)).toBe(false)
    expect(isCertValidityError(err)).toBe(true)
    // server.ts classifies a stringified upstream detail, so the message path
    // has to work on its own or the new line is unreachable there.
    expect(isCertValidityError(message)).toBe(true)
  })

  test("a hostname mismatch is not", () => {
    const err = Object.assign(
      new Error('ERR_TLS_CERT_ALTNAME_INVALID fetching "https://127.0.0.1:9556/"'),
      { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    )
    expect(isTlsTrustError(err)).toBe(false)
  })

  // The adapter interpolates upstream error bodies into the 502 it classifies,
  // so a bare /CERT_/ or /certificate chain/ drew the whole CA hint onto
  // failures that had nothing to do with trust.
  test.each([
    "rotating certificate chain nightly, retry later",
    "model CERT_test not supported",
    "upstream said: ERR_CERT_AUTHORITY_INVALID page",
  ])("prose is not: %s", (message) => {
    expect(isTlsTrustError(message)).toBe(false)
  })
})

// Every caller is a catch block, so a throw from here escapes the handler that
// was about to render a 502 or print the user's real error. These are the
// shapes that used to overflow the stack - not a totality claim: an object
// whose `cause` getter throws still propagates, and nothing suggests Bun or
// undici produces one.
describe("isTlsTrustError survives a looping error chain", () => {
  test("survives a cyclic cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown }
    const b = new Error("b") as Error & { cause?: unknown }
    a.cause = b
    b.cause = a
    expect(isTlsTrustError(a)).toBe(false)
  })

  test("stops walking a deep cause chain", () => {
    let err = new Error("leaf") as Error & { cause?: unknown }
    // Ten: the walk caps at depth 4, so a larger number would only look
    // significant.
    for (let i = 0; i < 10; i++) {
      err = Object.assign(new Error(`w${i}`), { cause: err })
    }
    expect(isTlsTrustError(err)).toBe(false)
  })

  // undici reports a multi-address failure this way, so the real trust error
  // is in `errors` rather than in `cause`.
  test("looks inside an AggregateError", () => {
    const inner = Object.assign(new Error("self signed certificate"), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    })
    expect(isTlsTrustError(new AggregateError([inner], "fetch failed"))).toBe(true)
  })
})

// caPaths is the single parser behind both clgpt's own trust store and the one
// path handed to the MCP child, so a disagreement between them shows up as
// "clgpt's probe passed but the child could not fetch" - the failure the child
// path exists to prevent. It had no direct coverage until it became shared.
describe("caPaths", () => {
  const cwd = process.cwd()

  test("splits, trims, and makes absolute", () => {
    expect(caPaths("/a/ca.pem:/b/ca.pem")).toEqual(["/a/ca.pem", "/b/ca.pem"])
    expect(caPaths(" /a/ca.pem ")).toEqual(["/a/ca.pem"])
    expect(caPaths("ca.pem")).toEqual([`${cwd}/ca.pem`])
  })

  test("expands ~, and treats a bare ~ as unset", () => {
    expect(caPaths("~/ca.pem")).toEqual([`${homedir()}/ca.pem`])
    // The home directory is not a certificate; passing it on produced an
    // EISDIR-class line instead of saying so.
    expect(caPaths("~")).toEqual([])
    // Only a path segment, not any leading tilde.
    expect(caPaths("~ca.pem")).toEqual([`${cwd}/~ca.pem`])
  })

  test("nothing configured is an empty list, not a path", () => {
    expect(caPaths(undefined)).toEqual([])
    expect(caPaths("")).toEqual([])
    expect(caPaths("   ")).toEqual([])
    // Empty segments from a stray or doubled separator.
    expect(caPaths("::/b/ca.pem")).toEqual(["/b/ca.pem"])
  })

  test("order is preserved, because the child gets the first that reads", () => {
    expect(caPaths("/z/ca.pem:/a/ca.pem")[0]).toBe("/z/ca.pem")
  })
})
