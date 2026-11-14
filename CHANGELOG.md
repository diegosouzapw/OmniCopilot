# Changelog

## 1.4.0

The most reported problems are fixed, the server URL and the API key got a security pass, and the
extension now carries the Cheaper Inference brand: **OmniRoute by Cheaper Inference for GitHub
Copilot Chat**.

### Fixed

- **The Context Window widget shows real token counts.** It stayed at 0 for every OmniRoute model
  because the extension never told VS Code how many tokens a response used. It now asks the server
  for the usage of each response and passes it on. Needs VS Code 1.120 or newer. Contributed by
  @SalatielBM22 in [#29](https://github.com/cheaper-inference/OmniCopilot/pull/29), fixing
  [#28](https://github.com/cheaper-inference/OmniCopilot/issues/28) and
  [#21](https://github.com/cheaper-inference/OmniCopilot/issues/21) (reported by @dedok3000).
- **Tool names longer than 64 characters no longer fail the request.** MCP tool names often pass
  the limit of Chat Completions, and OpenAI-format providers such as Azure reject the whole request.
  A longer name now goes out under a 64-character alias (its first 55 characters and a hash), in
  `tools[]` and in the tool calls of the history, and comes back to VS Code under its real name.
  Reported by @Narquadah in [#27](https://github.com/cheaper-inference/OmniCopilot/issues/27).
- **Rate limits and busy providers are retried for you.** A 408, 429 or 5xx, or a network failure,
  is retried up to twice, waiting the time the server asks for (`Retry-After`, or the
  "reset after 24s" hint in the error). No single wait is longer than 30 seconds and the whole
  thing gives up after a minute. It only retries while nothing has reached the chat, so an answer
  is never duplicated. Reported by @xbotuk in
  [#23](https://github.com/cheaper-inference/OmniCopilot/issues/23); the retry policy takes up what
  @atmediallc proposed in [#3](https://github.com/cheaper-inference/OmniCopilot/pull/3).
- **A tool that returns an image no longer floods the prompt.** The image bytes were serialised as
  text, about 300,000 tokens for a 100 KB screenshot. Images now go to vision models as images and
  become a short placeholder for the others. Parallel tool calls keep their results together, which
  strict providers require.
- **The token estimate counts what is actually sent.** Every data part used to cost a flat 4,000
  tokens, including internal markers and binary payloads that never leave the editor, so the context
  looked full long before it was.
- **Thinking effort can be chosen next to the model.** Models with extended thinking get a
  *Thinking effort* menu in the model picker (VS Code 1.120 or newer) with the tiers the model
  offers. The choice now reaches the request; before, only `omnicopilot.defaultReasoningEffort` did.
  `max` is a tier of its own instead of being folded into `xhigh`.
- **Model limits and names come from the catalog.** The extension read `max_completion_tokens` and
  `display_name`, which OmniRoute rarely sends, so every model got the default output budget and its
  raw id as a name. It now reads `max_output_tokens`, `max_input_tokens` and `name`.
- **"Offline" says why.** The panel shows the cause: nothing listening, no answer in time, a host
  name that does not resolve, a proxy answering in the server's place, a rejected TLS certificate,
  or something that is not OmniRoute at that address. It also says when the window is remote, where
  `localhost` is the remote machine, and points at `http.noProxy` when a proxy looks like the cause.
  Reported by @ned14 in [#18](https://github.com/cheaper-inference/OmniCopilot/issues/18) and in
  [#15](https://github.com/cheaper-inference/OmniCopilot/issues/15).
- **The usage section shows reset times and real balances.** Each limit and provider quota shows
  when it resets (contributed by @pacocartones in
  [#20](https://github.com/cheaper-inference/OmniCopilot/pull/20)). Quotas are resolved the way the
  server resolves them, and prepaid balances (DeepSeek, Kilo, Lyceum and others) show the money
  left, such as `$0.37 left`, instead of a percentage of nothing.
- **The model picker refills when the server comes back.** Starting OmniRoute after VS Code no
  longer leaves the picker empty until a manual refresh.
- Also fixed: an HTTP error from one model no longer marks the whole server offline. A model listing
  that never answers gives up after 15 seconds. A tool call that arrives without an id is kept. A
  malformed catalog entry no longer empties the picker. `omnicopilot.cliPath` accepts a quoted path
  with spaces. Servers that do not answer `HEAD` are probed with `GET`.

### Security

Reported by @jsalazarsana in [#31](https://github.com/cheaper-inference/OmniCopilot/issues/31).

- **A workspace can no longer redirect the extension.** `omnicopilot.baseUrl` is read from your
  user settings only (in a remote window, the remote machine's settings count too). A value in a
  workspace's `.vscode/settings.json` is ignored, and the panel says so when it finds one.
- **The API key is tied to the server it was saved for.** If the server URL changes, the key is
  not sent to the new server until you approve it, with Save & Test in the panel or *Use the key
  here* on the warning. The status bar shows a warning while the key is held back.
- **Plain HTTP outside your machine gets a warning**, once per server, before the key travels.
- **`omnicopilot.cliPath` is a machine setting** and is validated and quoted before it reaches a
  terminal. A server URL that carries shell syntax is refused instead of being typed into one.
- **The panel only runs this extension's commands**, and its content-security nonce comes from the
  platform's random source.

### Changed

- **New name, icon and colours.** The listing, the Activity Bar icon and the panel follow the
  Cheaper Inference brand. The extension id (`diegosouzapw.omnicopilot`) and every setting keep
  their names, so nothing needs to be reconfigured.
- **New home.** The repositories moved to
  [cheaper-inference/OmniCopilot](https://github.com/cheaper-inference/OmniCopilot) and
  [cheaper-inference/OmniRoute](https://github.com/cheaper-inference/OmniRoute). The old addresses
  redirect.
- **Four more tools in *Configure Coding CLI*:** Gemini CLI, Zed, WhyCodes and 5dive.
- **Translations.** Every new string ships in all 42 languages, and the test suite now fails when
  a string is missing from one of them.
- Development dependencies updated
  ([#30](https://github.com/cheaper-inference/OmniCopilot/pull/30),
  [#34](https://github.com/cheaper-inference/OmniCopilot/pull/34)).

## 1.3.0

- **Agents window (experimental, opt-in).** `omnicopilot.exposeToAgentsWindow` registers a
  second, agent-host-scoped set of entries for every tool-calling OmniRoute model, so they
  appear in the **Copilot Agents window** model picker (the regular chat picker is untouched).
  Requires the experimental VS Code setting `chat.agentHost.byokModels.enabled` and an
  agent-host restart; built on the proposed `targetChatSessionType` API, hence default-off.
  Requested in [#9](https://github.com/diegosouzapw/OmniCopilot/issues/9) by @Bulzi-Robb —
  implementation track [#14](https://github.com/diegosouzapw/OmniCopilot/issues/14).

## 1.2.0

- **The panel now shows your key's own spend.** A **My usage** section reads OmniRoute's
  self-service endpoint (`GET /api/usage/om-usage?format=json`) and renders the daily/weekly
  spend against its limit, the reset time, and each provider connection's quota side by side —
  Codex, Claude, OpenCode — instead of one provider's number. The three normal states are
  surfaced, not hidden behind a 0%: *usage not enabled for this key* (the `allowUsageCommand`
  flag is off by default), *nothing cached yet*, and — on a server too old for the JSON form —
  the section simply doesn't render. Closes
  [#12](https://github.com/diegosouzapw/OmniCopilot/issues/12) → resolves
  [#8](https://github.com/diegosouzapw/OmniCopilot/issues/8) once the OmniRoute side ships.
- **Settings are findable.** `OmniRoute: Open Settings` in the Command Palette and an
  **Extension settings** link in the panel — the discoverability half of
  [#10](https://github.com/diegosouzapw/OmniCopilot/issues/10).

## 1.1.0

- **Reasoning effort is forwarded to models that support extended thinking.**
  When VS Code offers an effort control next to the model, the choice now reaches
  OmniRoute as `reasoning_effort`; a new `omnicopilot.defaultReasoningEffort`
  setting covers the case where the editor does not expose one. Values use
  OmniRoute's canonical vocabulary (`none`/`low`/`medium`/`high`/`xhigh`) and the
  server downshifts a tier a model does not support, so asking for the top tier is
  always safe. The default only applies to models the catalog marks as
  reasoning-capable — sending the field to a model without thinking support is
  ignored at best and a 400 at worst. Reasoning models are now labelled
  "extended thinking" in the picker tooltip. Requested in
  [#7](https://github.com/diegosouzapw/OmniCopilot/issues/7) by @aliaksandrsen.
- **Security:** `sharp` 0.33 → 0.35 (high — inherited libvips CVE-2026-33327 /
  33328 / 35590 / 35591) and `esbuild` 0.24 → 0.28 (moderate — dev server could be
  read cross-origin). Both are build-time-only dependencies and never shipped
  inside the `.vsix`, so no published version was exploitable; `npm audit` is now
  clean.

## 1.0.2

- **The in-editor dashboard no longer opens a broken tab.** `dashboardOpen: "editor"`
  only guarded against the Simple Browser command being missing, which is the wrong
  failure mode: against a server that sends `X-Frame-Options: DENY` the command
  *succeeds* and the iframe renders a "refused to connect" page. The extension now
  checks the framing headers first and falls back to the external browser, explaining
  once that the server has to be **built** with `DASHBOARD_ALLOW_EMBED=vscode` — it is
  a build-time option, so setting the variable on an existing install is not enough.

## 1.0.1

Catalog and configuration fixes, validated against a live OmniRoute instance
serving 2345 catalog entries.

- **No more duplicate models in the picker.** OmniRoute defaults to
  `MODELS_CATALOG_PREFIX_MODE=dual`, which advertises every model twice — once
  under the short alias prefix and once under the canonical provider prefix
  (`cc/claude-sonnet-4-6` *and* `claude/claude-sonnet-4-6`). The extension now
  requests `?prefix=alias`, and independently drops mirror rows via their
  `parent` back-reference so servers too old for that parameter are covered as
  well. On the validation instance this removed **949 duplicates** with **zero
  models lost**.
- **Only conversational models reach the picker.** The catalog also lists
  image, video, audio and rerank registries, which the server rejects outright
  on `/v1/chat/completions`. Responses-API models (every Codex/GPT-5.x entry)
  are kept — OmniRoute translates those transparently.
- **`/v1` no longer leaks into your settings.** Configure the server root
  (`http://localhost:20128`); the extension appends `/v1` per request. Values
  already stored with `/v1` keep working and are never doubled.

## 1.0.0

First public release. 🎉

- **OmniRoute models in the Copilot Chat model picker** (VS Code stable ≥1.104 and Insiders) — live discovery from `GET /v1/models` with per-model tool-calling and vision capabilities from the OmniRoute catalog, combos included
- **Streaming responses** with full tool-calling round-trip (`tool_choice: required` honored) and image input for vision-capable models
- **Activity Bar panel**: connection status, model count, server URL and API key (SecretStorage / OS keychain), quick actions
- **Status-bar connection dot** with instant feedback from live requests
- **Localized in 42 languages** — mirroring the OmniRoute catalog (pt-BR, es, fr, de, ja, ko, zh-CN, zh-TW, ru, ar, hi, …)
- **Open Dashboard** in the external browser or in a VS Code editor tab (Simple Browser; editor mode requires an OmniRoute build that allows embedding)
- **Configure Coding CLI** command driving `omniroute setup-*` (Codex, Claude Code, Cline, Continue, Cursor, Aider, OpenCode, Goose, Crush, Qwen, Kilo, Roo)
- First-run onboarding with OmniRoute install pointers

## 0.1.0

Internal preview.
