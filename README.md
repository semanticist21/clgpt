# clgpt

Run Claude Code with a ChatGPT subscription through an unofficial community
OAuth adapter. `bun run src/cli.ts` starts a local Anthropic-compatible server, translates
Claude Code requests to the ChatGPT Codex Responses API, and launches the
stock `claude` CLI in an isolated config directory.

This project is not an OpenAI product and does not use an OpenAI API key.

## Install

Requirements: [Claude Code](https://claude.com/claude-code), an eligible
ChatGPT subscription, and [Bun](https://bun.sh). From npm (Bun is still
required at runtime):

```sh
npm install --global @semanticist14/clgpt
```

Update npm installs with `npm install --global @semanticist14/clgpt@latest`.

Or use the GitHub installer:

```sh
curl -fsSL https://raw.githubusercontent.com/semanticist21/clgpt/main/install.sh | bash
```

If Bun is missing, install it yourself:

```sh
curl -fsSL https://bun.sh/install | bash
```

Reopen your terminal after installing Bun. npm installs the package, but clgpt
still runs on Bun because the adapter uses Bun's server and process APIs; Node
is not a runtime fallback yet.

## First run

```sh
clgpt
```

The first run opens a browser for ChatGPT OAuth, then asks whether to bypass
permission prompts, replace Claude's unavailable built-in web search with
ChatGPT native search, enable Playwright browser control, and choose a model on
each start. Tokens are stored in `~/.config/clgpt/auth.json` with mode 600;
the Codex CLI cache is not read or shared.

Useful commands:

```sh
clgpt login       # sign in again in the browser
clgpt logout      # remove the clgpt OAuth session
clgpt status      # show account and model catalog
clgpt setup       # change startup defaults
clgpt update      # update after a staged install check
```

`clgpt --no-bypass`, `clgpt --no-browser`, `clgpt --no-web`, and
`clgpt --no-select` override a saved default for one run. `CLGPT_MODELS` can restrict the local allowlisted
GPT catalog with comma-separated ids.

## Web access

Claude's built-in WebSearch cannot work through an adapter: Anthropic executes
it server-side. With the web integration enabled, clgpt's adapter maps that
tool onto ChatGPT's native `web_search` instead, so the search executes
upstream and real results come back through Claude's own WebSearch. Claude's
built-in Fetch keeps working as-is: it fetches pages locally and only the
summarizing model call rides the adapter. No MCP server, no API key.
Existing installs keep this off until `clgpt setup` is run; use
`clgpt --no-web` for one run.

## Browser control

The optional Playwright MCP integration needs the Playwright browser extension,
which you install yourself. It does not install extensions or silently grant
browser access. The extension token can be stored without putting it in shell
history:

```sh
pbpaste | clgpt token
clgpt token --clear
```

Use `CLGPT_MCP_PACKAGE` to pin or redirect the MCP package. `--no-browser`
disables it for one session.

The default server package is pinned to `@playwright/mcp@0.0.80`; the browser
extension is installed and updated separately by Chrome. If you save an
extension token with `clgpt token`, it is kept in
`~/.config/clgpt/prefs.json` with mode 600 and is read only by the short-lived
MCP wrapper.

## Security and privacy

- OAuth credentials stay in `~/.config/clgpt/auth.json`; never commit that file.
- `bun run src/cli.ts` sends OAuth requests to `auth.openai.com` and model/chat requests to
  `chatgpt.com/backend-api/codex/responses`.
- Claude Code runs locally; the adapter binds to loopback and requires a local
  bearer token.
- Browser control is opt-in and uses the browser tab you explicitly share.
- This is an unofficial adapter. ChatGPT OAuth access and automated usage may
  change or stop working; use it only where your account and applicable terms
  permit.

## Updates

Updates are staged in a temporary checkout. Dependencies and a version smoke
test must pass before the live install is swapped, so a failed update leaves
the previous revision active. Local changes and non-fast-forward branches stop
the update.

## Development

```sh
bun install
bun test
bun run check
bash -n install.sh scripts/write-launcher.sh uninstall.sh
```

Run the mock upstream for local adapter tests:

```sh
bun run scripts/mock-upstream.ts
CLGPT_UPSTREAM=http://127.0.0.1:9099 bun run src/cli.ts -p "Reply with exactly OK"
```

License: [MIT](LICENSE)
