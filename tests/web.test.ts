import { expect, test } from "bun:test"
import { fetchContent, privateAddress, WebFetchError } from "../src/webfetch"

test("web_fetch classifies reserved and mapped addresses as private", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.1.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "2001:db8::1"]) expect(privateAddress(address)).toBe(true)
})

test("web_fetch rejects local and credential-bearing URLs before fetching", async () => {
  await expect(fetchContent("http://127.0.0.1:9/secret")).rejects.toBeInstanceOf(WebFetchError)
  await expect(fetchContent("https://user:pass@example.com/secret")).rejects.toThrow(/credential-free/)
})

test("web_fetch extracts a normal public HTML page", async () => {
  const result = await fetchContent("https://example.com")
  expect(result.contentType).toBe("text/html")
  expect(result.title).toBe("Example Domain")
})
