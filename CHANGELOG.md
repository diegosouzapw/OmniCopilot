# Change Log

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
- **No duplicate models in the picker**: Requests ?prefix=alias from OmniRoute and drops mirror rows.
- **Only conversational models reach the picker**: Filters out non-chat registries.
- **Multi-Route & Deleted Model Cleanup**: Automatically updates cache and prunes stale routes.
- **Metrics & Usage Performance**: Fixed token overcounting.

## 1.0.0
- Initial release.
