// Trust for TLS-inspecting corporate networks (ZTNA, MITM proxies).
//
// Every outbound HTTPS call clgpt makes happens in THIS process — the claude
// child only ever talks plaintext to the local adapter. So the CA has to be
// trusted here, and a failure surfaces to the user as an adapter 502 rendered
// inside claude's UI rather than as a TLS error from claude itself.
//
// We pass the bundle per request via Bun's `tls.ca`, which unions with the
// default trust store rather than replacing it, and needs nothing decided
// before the process starts. NODE_USE_SYSTEM_CA is a no-op on Bun, whose
// default set already merges the bundled and system roots.
//
// NODE_EXTRA_CA_CERTS is reported to REPLACE the system store rather than add
// to it on some builds. That did not reproduce here - measured on bun 1.3.14
// and node 24, adding a private CA left registry.npmjs.org validating - so it
// is stated as an unconfirmed report rather than as fact. clgpt uses it for the
// MCP child, which has no per-request hook, and `tls.ca` for itself.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { getCACertificates } from "node:tls"

/**
 * The paths CLGPT_CA_BUNDLE names, absolute.
 *
 * The single parser, because there used to be two: this one trimmed the raw
 * value before splitting and the one handing a path to the MCP child did not,
 * so " /a/ca.pem " worked in-process and reached the child as a cwd-joined
 * nonsense path - clgpt's own probe passing while the child could not fetch,
 * which is the asymmetry that whole code path exists to remove. Absolute
 * because the child resolves relative paths against its own cwd, and `~` is
 * expanded because the README documents that spelling and only an unquoted
 * shell was expanding it.
 */
export function caPaths(raw = process.env.CLGPT_CA_BUNDLE): string[] {
  return (raw ?? "")
    .split(":")
    .map((path) => path.trim())
    // A bare "~" is the home DIRECTORY, which readFileSync then reports as
    // EISDIR - a confusing line for a value that can never be a certificate.
    .filter((path) => path !== "" && path !== "~")
    .map((path) =>
      path === "~" || path.startsWith("~/")
        ? join(homedir(), path.slice(1))
        : resolve(path),
    )
}

let resolved: string[] | null | undefined
let readablePath: string | undefined

/**
 * The default trust store plus any CA named by CLGPT_CA_BUNDLE (one path, or
 * several separated by ":"). Undefined when no extra CA is configured, so the
 * request keeps Bun's own default handling.
 */
export function caBundle(): string[] | undefined {
  if (resolved !== undefined) return resolved ?? undefined
  const paths = caPaths()
  if (paths.length === 0) {
    resolved = null
    return undefined
  }
  const extra: string[] = []
  for (const path of paths) {
    try {
      extra.push(readFileSync(path, "utf8"))
      readablePath ??= path
    } catch (err) {
      console.error(
        `[clgpt] could not read CA bundle: ${path} (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  }
  if (extra.length === 0) {
    resolved = null
    return undefined
  }
  try {
    // Union, never replace.
    resolved = [...getCACertificates("default"), ...extra]
  } catch {
    // An older Bun without the default store: still better to trust the extra
    // CA than to let the throw turn every upstream request into a 502.
    resolved = extra
  }
  return resolved
}

/**
 * The first CLGPT_CA_BUNDLE path that actually read, for handing to a child
 * process that can only take one.
 *
 * "First that read", not "first listed": clgpt used to log ENOENT for a path
 * and then forward that same path to the MCP server anyway, where bun's only
 * complaint is a warning on a stderr claude's UI does not show.
 */
export function caChildPath(): string | undefined {
  caBundle()
  return readablePath
}

/** Test seam: forget a cached bundle so a changed env is picked up. */
export function resetCaBundle(): void {
  resolved = undefined
  readablePath = undefined
}

/**
 * OpenSSL verify codes that mean "I do not trust this chain" - which is what a
 * TLS-inspecting proxy produces, and what CLGPT_CA_BUNDLE fixes. Bun populates
 * `code` on the thrown error, so this is the reliable discriminator; the
 * message text is not. Matching on text alone missed
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE, whose message is "unable to verify the
 * first certificate" - a proxy presenting a leaf without shipping its
 * intermediate, i.e. the most ordinary corporate shape there is. It was
 * reported as an unreachable host, sending the user to their firewall team
 * instead of to their CA.
 */
/**
 * Codes where the chain and the name are fine but the clock is not. No CA
 * bundle fixes these, so they are not trust failures - but the host answered,
 * so they are not "cannot reach" either, which is how an expired MITM
 * certificate used to send the user to their firewall team.
 */
const VALIDITY_CODES = new Set(["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"])

/** Whether a failure is an expired or not-yet-valid certificate. */
export function isCertValidityError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string" && VALIDITY_CODES.has(code)) return true
  }
  const message = typeof err === "string" ? err : String((err as Error)?.message ?? err)
  // The message path matters as much as the code: server.ts classifies a
  // stringified upstream detail, so a code-only check would leave the new
  // wording unreachable there.
  return /certificate has expired|certificate is not yet valid|\bCERT_(HAS_EXPIRED|NOT_YET_VALID)\b/i.test(
    message,
  )
}

const TRUST_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  // Deliberately NOT ERR_TLS_CERT_ALTNAME_INVALID: that chain verified and
  // only the name did not match, so no CA bundle can fix it. Including it made
  // clgpt tell a user whose bundle worked perfectly that their bundle did not
  // cover the chain, and print the whole CA hint besides.
])

/**
 * Whether a failure is a broken trust chain rather than an unreachable host.
 *
 * Accepts the thrown error (preferred - it carries `code`) or just a message,
 * since some call sites only have the string.
 */
export function isTlsTrustError(err: unknown): boolean {
  // The depth budget is deliberately not a public parameter: as a second
  // argument, `msgs.some(isTlsTrustError)` fed it the array index and silently
  // disabled the cause walk from index 4 on.
  return trustError(err, 0)
}

function trustError(err: unknown, depth: number): boolean {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string" && TRUST_CODES.has(code)) return true
    // Bounded: a cyclic `cause` chain used to overflow the stack, and since
    // every caller is an error handler the RangeError escaped the catch that
    // was about to render a 502 or print the user's real error.
    if (depth < 4) {
      const cause = (err as { cause?: unknown }).cause
      if (cause !== undefined && cause !== err && trustError(cause, depth + 1)) {
        return true
      }
      // undici reports a multi-address failure as an AggregateError, so the
      // real trust error is in `errors`, not in `cause`.
      const nested = (err as { errors?: unknown }).errors
      if (Array.isArray(nested)) {
        for (const one of nested) {
          if (one !== err && trustError(one, depth + 1)) return true
        }
      }
    }
  }
  const message = typeof err === "string" ? err : String((err as Error)?.message ?? err)
  // Fallback for a stringified error, or a Bun/Node build that omits the code.
  // Anchored to the codes and the exact OpenSSL phrasings: a bare /CERT_/ or
  // /certificate chain/ matched ordinary prose, so an upstream error body
  // echoed into the adapter's 502 ("rotating certificate chain nightly") drew
  // the whole CA hint onto a failure that had nothing to do with trust.
  return (
    /self[- ]signed certificate( in certificate chain)?|unable to (get local issuer certificate|get issuer certificate|verify the first certificate)/i.test(
      message,
    ) ||
    /\b(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|CERT_UNTRUSTED)\b/.test(
      message,
    )
  )
}

/**
 * What to tell the user about a trust failure.
 *
 * Adapts to whether a bundle actually loaded: telling someone who already
 * exported a CA to export a CA is the advice this message exists to replace,
 * and the one-line browser status already got this right.
 */
export function tlsHint(caLoaded = caBundle() !== undefined): string {
  if (caLoaded) {
    return (
      "\nYour CLGPT_CA_BUNDLE loaded, but nothing in it signed this chain.\n" +
      "  - Export the ISSUING CA, not the leaf certificate the proxy presents.\n" +
      '  - macOS: security find-certificate -a -p -c "<CA name>" > ca.pem\n' +
      "  - Several CAs can be joined with \":\" - clgpt unions them all.\n" +
      "Never disable TLS verification: OAuth credentials use this connection."
    )
  }
  return (
    "\nThis looks like a corporate proxy re-signing TLS. To fix it:\n" +
    "  1) Get your company CA as a file, then:\n" +
    "       CLGPT_CA_BUNDLE=/path/ca.pem clgpt ...\n" +
    "     It is ADDED to the OS trust store, never replaces it.\n" +
    '  2) Export it from the macOS keychain:\n' +
    '       security find-certificate -a -p -c "<CA name>" > ca.pem\n' +
    "Never disable TLS verification: OAuth credentials use this connection."
  )
}
