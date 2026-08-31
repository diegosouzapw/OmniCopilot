<h1 align="center">OmniRoute for GitHub Copilot Chat</h1>

<p align="center">
  <img src="assets/icon.png" alt="OmniCopilot" width="128">
</p>

<p align="center">
  <strong>1200+ AI models in your Copilot Chat — free &amp; forever free.</strong><br>
  <em>340+ providers, 90+ with free tiers, one endpoint. MIT open source.</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=diegosouzapw.omnicopilot"><strong>🧩 Install from the VS Code Marketplace</strong></a><br>
  <a href="https://open-vsx.org/extension/diegosouzapw/omnicopilot"><strong>🔓 Install from Open VSX</strong></a> <em>(Cursor, Windsurf, VSCodium, Theia, code-server…)</em>
</p>

<p align="center">
  <a href="https://github.com/diegosouzapw/OmniRoute">🌐 OmniRoute on GitHub</a> •
  <a href="https://github.com/diegosouzapw/OmniCopilot">🔌 Extension source</a> •
  <a href="https://github.com/diegosouzapw/OmniRoute/issues">🐛 Issues</a>
</p>

---

**Don't replace Copilot — power it up.** No new sidebar to learn, no new chat UI. This extension drops every model from your [OmniRoute](https://github.com/diegosouzapw/OmniRoute) server — Kimi, Claude, GPT, Gemini, GLM, DeepSeek, Qwen, Llama and hundreds more across **340+ providers, 90+ of them with free tiers that stay free** — straight into the model picker of the Copilot Chat you already use. Including **VS Code Insiders**.

> 🆓 **No Copilot subscription required.** Since VS Code 1.122, provider models work without a GitHub sign-in and without any Copilot plan. VS Code + OmniRoute + this extension = a fully working AI chat with agent mode, for free.

## Why this extension?

- **1200+ models, one picker.** OmniRoute unifies 340+ providers (OpenAI-compatible, Anthropic, Gemini, Ollama, local, OAuth-based free tiers…) behind a single endpoint — **90+ providers are free, and free forever**. Every model it serves shows up in your Copilot Chat model dropdown.
- **Agent mode, tool calling, MCP, instructions — all of it still works.** This plugs into VS Code's native language-model provider API, so Copilot's entire stack now runs on the model *you* choose.
- **Vision included.** Models flagged as vision-capable in the OmniRoute catalog accept image attachments directly in chat.
- **Combos & auto-fallback.** OmniRoute combos (priority, round-robin, cost-optimized, fusion…) appear as regular models — pick one and get automatic failover across providers behind the scenes.
- **Online at a glance.** A status-bar dot and an Activity Bar panel show whether your OmniRoute server is reachable, how many models it serves, and where to configure everything — URL and API key included.
- **Speaks your language.** The UI ships in 42 languages, mirroring OmniRoute's own catalog — VS Code picks the one matching your display language automatically.
- **Configure your other tools too.** One command configures Codex CLI, Claude Code, Cline, Continue, Cursor, Aider and more to use OmniRoute — powered by the `omniroute` CLI under the hood.
- **Secure by default.** The API key lives in VS Code's SecretStorage (OS keychain), never in `settings.json`.

## Getting started

### 1. Run OmniRoute (60 seconds)

```bash
npm install -g omniroute
omniroute        # dashboard at http://localhost:20128
```

Add your providers/keys in the dashboard — or use the built-in free ones. Full guide: [github.com/diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute).

Already running OmniRoute somewhere else (home server, VPS, tunnel)? Point the extension at it — see below.

### 2. Install this extension

Search for **"OmniRoute"** in the VS Code Extensions view — it resolves from the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=diegosouzapw.omnicopilot) on VS Code
and from [Open VSX](https://open-vsx.org/extension/diegosouzapw/omnicopilot) on forks like Cursor,
Windsurf and VSCodium. Or grab the `.vsix` from the [releases](https://github.com/diegosouzapw/OmniCopilot/releases).

### 3. Pick a model

1. Open Copilot Chat and click the **model picker**
2. Choose **Manage Models…** → **OmniRoute**
3. Tick the models you want — they now live in your picker

That's it. If OmniRoute runs on the default `http://localhost:20128`, there is nothing to configure.

## Remote server / API key

Click the **OmniRoute icon in the Activity Bar** (or run `OmniRoute: Manage Connection`, or click the status-bar dot) to open the connection panel:

- **Server URL** — e.g. `http://my-vps:20128` (the `/v1` suffix is added automatically)
- **API key** — only if your OmniRoute requires one (`REQUIRE_API_KEY`); stored in the OS keychain
- **Save & Test** — instant feedback with the live model count

## Configure your coding CLIs

Run **`OmniRoute: Configure Coding CLI`** and pick a tool — the extension drives the `omniroute` CLI to generate ready-to-use profiles:

| Tool | What you get |
| --- | --- |
| Codex CLI | `codex --profile glm52` style profiles in `~/.codex` |
| Claude Code | `omniroute launch --profile <name>` launch profiles |
| Cline / Roo / Kilo | Extension settings pointed at OmniRoute |
| Continue / Cursor / Aider / Goose / Crush / OpenCode / Qwen Code | Tool-native config |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `omnicopilot.baseUrl` | `http://localhost:20128` | OmniRoute server root (local or remote) — `/v1` is appended automatically |
| `omnicopilot.modelFilter` | *(empty)* | Substring/regex to limit which models are listed |
| `omnicopilot.maxOutputTokens` | `16384` | Output budget reserved per response |
| `omnicopilot.defaultContextLength` | `128000` | Context assumed when the catalog omits it |
| `omnicopilot.statusBar` | `true` | Show the connection dot |
| `omnicopilot.healthCheckIntervalSeconds` | `30` | Probe frequency |
| `omnicopilot.dashboardOpen` | `external` | Open the dashboard in the browser, or in a VS Code tab (`editor`) — see below |
| `omnicopilot.defaultReasoningEffort` | *(unset)* | Effort for models with extended thinking — `none`/`low`/`medium`/`high`/`xhigh`; see below |
| `omnicopilot.cliPath` | `omniroute` | Path to the OmniRoute CLI |
| `omnicopilot.exposeToAgentsWindow` | `false` | Experimental: also list the models in the Copilot Agents window — see below |

### Reasoning effort

Models with extended thinking (GPT-5.x, Claude with thinking, DeepSeek R1, Gemini
Thinking…) accept a reasoning tier. When VS Code shows an effort control next to the model,
that choice is forwarded to OmniRoute as `reasoning_effort` — you do not have to configure
anything.

`omnicopilot.defaultReasoningEffort` covers the case where the editor exposes no control. It
uses OmniRoute's canonical vocabulary — `none`, `low`, `medium`, `high`, `xhigh` — and the
server downshifts a tier a model does not implement, so asking for `xhigh` is always safe.

The default is applied **only** to models the catalog marks as reasoning-capable: sending the
field to a model without thinking support is ignored at best and rejected with a 400 at worst.
An explicit choice from the chat UI always wins over the setting.

### Agents window (experimental)

Turn on `omnicopilot.exposeToAgentsWindow` to also register every tool-calling OmniRoute model
for the **Copilot Agents window** (the Copilot CLI agent host). VS Code scopes these entries to
agent-host sessions, so they appear in the Agents window's model picker instead of the regular
chat picker — the regular picker keeps working unchanged.

Prerequisites, both on the VS Code side:

1. Enable the experimental VS Code setting `chat.agentHost.byokModels.enabled`.
2. Restart the agent host (or reload the window) after flipping the settings.

This rides a **proposed** VS Code API (`targetChatSessionType`), which is why it ships opt-in
and default-off: the mechanism can change under us in a VS Code update. If the entries show up
duplicated in the regular picker instead of the Agents window, your VS Code build does not
support the proposal yet — turn the setting back off.

### Your usage in the panel

When OmniRoute runs a recent enough version, the Activity Bar panel shows a **My usage**
section — your key's own daily/weekly spend against its limit, the reset time, and the quota
of each provider connection (Codex, Claude, OpenCode…) side by side.

It reads the self-service endpoint `GET /api/usage/om-usage?format=json` with your connection's
API key — the same data as the terminal `@@om-usage` command, never the management surface.

Three states are normal and distinct:

- **"Usage is not enabled for this key"** — the key lacks the `allowUsageCommand` flag, which
  is **off by default**. An admin turns it on per key in OmniRoute's API-key manager. This is a
  setting, not an error.
- **"nothing is cached yet"** — the key is allowed but the server has no learned quota for the
  connection yet. It fills in after the first requests.
- **No section at all** — the OmniRoute server predates `?format=json`; the panel hides it
  rather than parse the older text form.

Requires OmniRoute with the usage JSON endpoint (v3.8.50+). See
[`docs/CATALOG.md`](docs/CATALOG.md) for the server version the feature matrix assumes.

### Dashboard inside VS Code

Set `omnicopilot.dashboardOpen` to `editor` to open the OmniRoute dashboard in a VS Code tab
instead of your browser. This needs the server to allow embedding, which is opt-in via
**`DASHBOARD_ALLOW_EMBED=vscode`** (landed in
[OmniRoute #10273](https://github.com/diegosouzapw/OmniRoute/issues/10273)).

⚠️ That flag is read at **build time** — Next.js bakes the response headers into the route
manifest — so exporting it in front of an already-installed server does nothing. It works on a
build from source (`DASHBOARD_ALLOW_EMBED=vscode npm run build`), not on the prebuilt
`npm install -g omniroute` package or the official Docker image. Full matrix in the
[OmniRoute guide](https://github.com/diegosouzapw/OmniRoute/blob/main/docs/guides/VSCODE-COPILOT.md#dashboard-inside-a-vs-code-tab).

Without an embed-enabled build the page refuses to frame; the extension detects that from the
response headers and falls back to the external browser, so nothing breaks either way.

## How the model list is built

Curious why the picker shows the number of models it shows, or why a provider you never
configured is in there? → **[`docs/CATALOG.md`](docs/CATALOG.md)** explains the duplicate-prefix
mode, the non-chat filter and the free/keyless providers, with measured numbers.

## Good to know

- **Chat, agent mode and utility tasks** run through your OmniRoute models. Inline code completions and embeddings-based features are outside VS Code's provider API and still require GitHub Copilot.
- On **Copilot Business/Enterprise**, admins can disable third-party model providers via the "Bring Your Own Language Model Key" policy.
- Requires VS Code **1.104+** (older versions than 1.122 also need a signed-in Copilot plan — that's a VS Code rule, not ours).

## Free & open source

OmniRoute is MIT-licensed and free forever — ⭐ [star it on GitHub](https://github.com/diegosouzapw/OmniRoute) and join the project. This extension is MIT too; issues and PRs welcome at [diegosouzapw/OmniCopilot](https://github.com/diegosouzapw/OmniCopilot). Maintainers publishing a new version: see [`docs/PUBLISHING.md`](docs/PUBLISHING.md) (Marketplace + Open VSX).

---

*OmniRoute is an independent open-source project, not affiliated with GitHub or Microsoft. GitHub Copilot is a trademark of GitHub, Inc.*
