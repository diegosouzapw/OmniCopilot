<h1 align="center">OmniRoute by Cheaper Inference for GitHub Copilot Chat</h1>

<p align="center"><strong>Created by <a href="https://github.com/diegosouzapw">Diego Souza</a></strong></p>

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
  <a href="https://github.com/cheaper-inference/OmniRoute">🌐 OmniRoute on GitHub</a> •
  <a href="https://github.com/cheaper-inference/OmniCopilot">🔌 Extension source</a> •
  <a href="https://github.com/cheaper-inference/OmniRoute/issues">🐛 Issues</a>
</p>

---

**Don't replace Copilot — power it up.** No new sidebar to learn, no new chat UI. This extension drops every model from your [OmniRoute](https://github.com/cheaper-inference/OmniRoute) server — Kimi, Claude, GPT, Gemini, GLM, DeepSeek, Qwen, Llama and hundreds more across **340+ providers, 90+ of them with free tiers that stay free** — straight into the model picker of the Copilot Chat you already use. Including **VS Code Insiders**.

> 🆓 **No Copilot subscription required.** Since VS Code 1.122, provider models work without a GitHub sign-in and without any Copilot plan. VS Code + OmniRoute + this extension = a fully working AI chat with agent mode, for free.

## Why this extension?

- **1200+ models, one picker.** OmniRoute unifies 340+ providers (OpenAI-compatible, Anthropic, Gemini, Ollama, local, OAuth-based free tiers…) behind a single endpoint — **90+ providers are free, and free forever**. Every model it serves shows up in your Copilot Chat model dropdown.
- **Agent mode, tool calling, MCP, instructions — all of it still works.** This plugs into VS Code's native language-model provider API, so Copilot's entire stack now runs on the model *you* choose.
- **Vision included.** Models flagged as vision-capable in the OmniRoute catalog accept image attachments directly in chat.
- **Combos & auto-fallback.** OmniRoute combos (priority, round-robin, cost-optimized, fusion…) appear as regular models — pick one and get automatic failover across providers behind the scenes.
- **Online at a glance.** A status-bar dot and an Activity Bar panel show whether your OmniRoute server is reachable, how many models it serves, and where to configure everything — URL and API key included.
- **Speaks your language.** The UI ships in 42 languages, mirroring OmniRoute's own catalog — VS Code picks the one matching your display language automatically.
- **Configure your other tools too.** One command configures Codex CLI, Claude Code, Cline, Continue, Cursor, Aider and more to use OmniRoute — powered by the `omniroute` CLI under the hood.
- **Secure by default.** The API key lives in VS Code's SecretStorage (OS keychain), never in `settings.json`, and it is only sent to the server you saved it for. A repository you open cannot point the extension somewhere else.

## Getting started

### 1. Run OmniRoute (60 seconds)

```bash
npm install -g omniroute
omniroute        # dashboard at http://localhost:20128
```

Add your providers/keys in the dashboard — or use the built-in free ones. Full guide: [github.com/cheaper-inference/OmniRoute](https://github.com/cheaper-inference/OmniRoute).

Already running OmniRoute somewhere else (home server, VPS, tunnel)? Point the extension at it — see below.

### 2. Install this extension

Search for **"OmniRoute"** in the VS Code Extensions view — it resolves from the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=diegosouzapw.omnicopilot) on VS Code
and from [Open VSX](https://open-vsx.org/extension/diegosouzapw/omnicopilot) on forks like Cursor,
Windsurf and VSCodium. Or grab the `.vsix` from the [releases](https://github.com/cheaper-inference/OmniCopilot/releases).

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

Two rules keep the connection yours:

- **The server URL comes from your user settings.** In a remote window (WSL, SSH, a dev container) the remote machine's settings count too. A value in a workspace's `.vscode/settings.json` is ignored, so opening a repository cannot point the extension at another server.
- **The API key is tied to the server it was saved for.** If the URL changes, the key stays put until you approve the new server, with **Save & Test** or **Use the key here** on the warning. A server reached over plain `http://` outside your own machine gets a one-time warning before the key travels.

### Troubleshooting the connection

When the server cannot be reached, the panel says why instead of only "Offline":

| The panel says | Usual cause |
| --- | --- |
| Nothing is listening (connection refused) | OmniRoute is not running, or the URL points at the wrong machine or port |
| No answer within a few seconds | A firewall, or a host that is down |
| The network cannot reach the address | No route from this machine: a VPN that is off, or another subnet |
| The host name could not be resolved | A typo in the URL, or DNS |
| The request failed at a proxy | VS Code sent the request through a proxy. Add the host to `http.noProxy` |
| The TLS certificate was rejected | A self-signed or expired certificate on an `https://` server |
| Answered HTTP *n*, which is not what an OmniRoute server answers | Something else is listening at that address |

Two situations explain most reports:

- **Remote windows.** In WSL, over SSH, in a dev container or a Codespace, the extension runs on the remote machine. `localhost` is that machine, not your own computer. Use an address the remote can reach, and set it in the panel from that window.
- **Proxies.** VS Code routes extension requests through its proxy settings, LAN addresses included. If `curl` reaches the server from a terminal and the extension does not, add the host to `http.noProxy`, for example `"http.noProxy": ["192.168.2.4"]`.

## Configure your coding CLIs

Run **`OmniRoute: Configure Coding CLI`** and pick a tool — the extension drives the `omniroute` CLI to generate ready-to-use profiles:

| Tool | What you get |
| --- | --- |
| Codex CLI | `codex --profile glm52` style profiles in `~/.codex` |
| Claude Code | `omniroute launch --profile <name>` launch profiles |
| Cline / Roo / Kilo | Extension settings pointed at OmniRoute |
| Continue / Cursor / Aider / Goose / Crush / OpenCode / Qwen Code / Gemini CLI / Zed / WhyCodes / 5dive | Tool-native config |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `omnicopilot.baseUrl` | `http://localhost:20128` | OmniRoute server root (local or remote) — `/v1` is appended automatically. Read from your user settings; a workspace value is ignored |
| `omnicopilot.modelFilter` | *(empty)* | Substring/regex to limit which models are listed |
| `omnicopilot.maxOutputTokens` | `16384` | Output budget reserved per response |
| `omnicopilot.defaultContextLength` | `128000` | Context assumed when the catalog omits it |
| `omnicopilot.statusBar` | `true` | Show the connection dot |
| `omnicopilot.healthCheckIntervalSeconds` | `30` | Probe frequency |
| `omnicopilot.dashboardOpen` | `external` | Open the dashboard in the browser, or in a VS Code tab (`editor`) — see below |
| `omnicopilot.defaultReasoningEffort` | *(unset)* | Effort for models with extended thinking — `none`/`low`/`medium`/`high`/`xhigh`/`max`; see below |
| `omnicopilot.cliPath` | `omniroute` | Path to the OmniRoute CLI (a machine setting; put a path with spaces in quotes) |
| `omnicopilot.exposeToAgentsWindow` | `false` | Experimental: also list the models in the Copilot Agents window — see below |

### Reasoning effort

Models with extended thinking (GPT-5.x, Claude with thinking, DeepSeek R1, Gemini
Thinking…) accept a reasoning tier.

On VS Code 1.120 and newer those models get a **Thinking effort** menu in the model picker,
with the tiers the model offers: Off, Low, Medium, High, Extra high and Max. Pick one and it is
sent to OmniRoute as `reasoning_effort` on every request to that model.

`omnicopilot.defaultReasoningEffort` sets what is used until you pick something, and covers
editors that show no menu. It uses OmniRoute's vocabulary (`none`, `low`, `medium`, `high`,
`xhigh`, `max`), and the server steps down a tier a model does not implement, so asking for
`max` is always safe.

The default is applied **only** to models the catalog marks as reasoning-capable: sending the
field to a model without thinking support is ignored at best and rejected with a 400 at worst.
A choice made in the picker always wins over the setting.

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

Each line shows what is left and when it resets. A quota that is a prepaid balance (DeepSeek,
Kilo, Lyceum…) shows the money left, such as `$0.37 left`, instead of a percentage.

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
[OmniRoute #10273](https://github.com/cheaper-inference/OmniRoute/issues/10273)).

⚠️ That flag is read at **build time** — Next.js bakes the response headers into the route
manifest — so exporting it in front of an already-installed server does nothing. It works on a
build from source (`DASHBOARD_ALLOW_EMBED=vscode npm run build`), not on the prebuilt
`npm install -g omniroute` package or the official Docker image. Full matrix in the
[OmniRoute guide](https://github.com/cheaper-inference/OmniRoute/blob/main/docs/guides/VSCODE-COPILOT.md#dashboard-inside-a-vs-code-tab).

Without an embed-enabled build the page refuses to frame; the extension detects that from the
response headers and falls back to the external browser, so nothing breaks either way.

## How the model list is built

Curious why the picker shows the number of models it shows, or why a provider you never
configured is in there? → **[`docs/CATALOG.md`](docs/CATALOG.md)** explains the duplicate-prefix
mode, the non-chat filter and the free/keyless providers, with measured numbers.

## Good to know

- **Chat, agent mode and utility tasks** run through your OmniRoute models. Inline code completions and embeddings-based features are outside VS Code's provider API and still require GitHub Copilot.
- **Temporary errors are retried.** A rate limit or a busy provider is retried up to twice before you see an error, as long as nothing has been shown in the chat yet.
- **Long tool names work.** MCP tool names over 64 characters are shortened on the wire and restored on the way back, so OpenAI-format providers accept them.
- On **Copilot Business/Enterprise**, admins can disable third-party model providers via the "Bring Your Own Language Model Key" policy.
- Requires VS Code **1.104+** (older versions than 1.122 also need a signed-in Copilot plan — that's a VS Code rule, not ours).

## Free & open source

OmniRoute is MIT-licensed and free forever — ⭐ [star it on GitHub](https://github.com/cheaper-inference/OmniRoute) and join the project. This extension is MIT too; issues and PRs welcome at [cheaper-inference/OmniCopilot](https://github.com/cheaper-inference/OmniCopilot). Maintainers publishing a new version: see [`docs/PUBLISHING.md`](docs/PUBLISHING.md) (Marketplace + Open VSX).

---

<p align="center">© 2026 OmniRoute · A Cheaper Inference product · MIT License · Created by <a href="https://github.com/diegosouzapw">Diego Souza</a></p>

*OmniRoute is an independent open-source project, not affiliated with GitHub or Microsoft. GitHub Copilot is a trademark of GitHub, Inc.*
