# Publishing OmniCopilot

Two stores, two accounts, two CLIs. Both consume the same `.vsix` produced by `npm run package`
/ `npm run vsix` — there is no store-specific build.

| Store | Who's it for | CLI | Account |
| --- | --- | --- | --- |
| **VS Code Marketplace** | VS Code stable & Insiders | [`@vscode/vsce`](https://www.npmjs.com/package/@vscode/vsce) | Azure DevOps (Microsoft) |
| **Open VSX Registry** | Cursor, Windsurf, VSCodium, Theia, code-server, Gitpod, Antigravity, Kiro, IBM Bob | [`ovsx`](https://www.npmjs.com/package/ovsx) | Eclipse Foundation |

Microsoft's terms forbid other products from consuming the Marketplace or redistributing its
`.vsix` files — that's why forks default to Open VSX instead. Publish to **both** or users on
non-Microsoft VS Code forks never see the extension.

---

## 1. VS Code Marketplace (`vsce`)

### One-time setup — Personal Access Token (PAT)

The token is **not** created on the Marketplace management page
(`marketplace.visualstudio.com/manage/...`) — that page has no token screen. It lives on a
separate site:

1. Go to **https://dev.azure.com** and sign in with the account that owns the `diegosouzapw`
   publisher.
2. User settings (gear icon, top right) → **Personal access tokens** → **+ New Token**.
3. **Organization: "All accessible organizations"** — this is not optional. A token scoped to a
   single org returns `401` on publish even though it looks valid everywhere else.
4. **Show all scopes** → **Marketplace → Manage** → Create. Copy it now; it is shown once.
5. First time on Azure DevOps? It asks you to create an *organization* before issuing tokens —
   any name works, it's unrelated to the publisher.

Global Azure DevOps PATs **retire 2026-12-01**. Before then, switch to Entra ID auth
(`vsce publish --azure-credential` — see the [vsce README](https://github.com/microsoft/vscode-vsce#usage)).

### Publish

```bash
npx vsce login diegosouzapw   # interactive: pastes the PAT into the OS keychain, once
npx vsce publish               # bumps nothing — publishes package.json's current version
```

Or non-interactively (CI, or handing a token to an agent): `VSCE_PAT=<token> npx vsce publish`.
Prefer `vsce login` when a human is present — the token then never appears in a chat/log
transcript. If a token *did* travel through a chat or CI log, rotate it on dev.azure.com after
publishing.

Sanity-check a token before publishing: `npx vsce verify-pat diegosouzapw`.

### Verifying the publish landed

**The extension's own page (`marketplace.visualstudio.com/items?itemName=...`) can 404 for a
few minutes after a successful publish** — that's CDN propagation, not a failure. To confirm
immediately, hit the gallery API directly:

```bash
curl -s -X POST "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json;api-version=7.2-preview.1" \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"diegosouzapw.omnicopilot"}],"pageSize":1,"pageNumber":1}],"flags":914}'
```

`filterType: 7` means "look up by extension id".

**Careful: that endpoint caches too.** After the 1.0.1 publish it kept answering `1.0.0`
for well over ten minutes while the release was already live. The authoritative check is

```bash
npx vsce show diegosouzapw.omnicopilot     # lists every published version
```

and the definitive one is fetching the artifact itself — a `200` here means the version
exists on the CDN, whatever any page or query says:

```bash
curl -sIL -o /dev/null -w '%{http_code}\n' \
  https://marketplace.visualstudio.com/_apis/public/gallery/publishers/diegosouzapw/vsextensions/omnicopilot/<version>/vspackage
```

Do not re-publish because a page still shows the old version — you will only get
"already exists". Open VSX, by contrast, reflected the new version in about a minute.

---

## 2. Open VSX Registry (`ovsx`)

### One-time setup — namespace + token

1. Create an account at **https://open-vsx.org** (GitHub login) if you don't have one.
2. Generate an access token from your Open VSX profile → **Access Tokens**.
3. Claim the namespace once: `npx ovsx create-namespace diegosouzapw -p <token>`.

### ⚠️ Publisher Agreement — required before ANY version becomes visible

> **Status: signed** (2026-08-17). Signing it retroactively activated the 1.0.0
> that had been published-but-invisible, so this is a one-time step — later
> releases publish normally. Kept here because the failure mode is silent and
> the error message does not mention the agreement.

`ovsx publish` can report `🚀 Published diegosouzapw.omnicopilot v1.0.0` and still leave the
extension **invisible** on the registry. Re-running the publish then fails with:

```
Error: Extension diegosouzapw.omnicopilot 1.0.0 is already published, but currently
isn't active and therefore not visible.
```

This means the publisher has not signed the **Eclipse Foundation Open VSX Publisher
Agreement** — a one-time, browser-only step; it cannot be done via the CLI or a token:

1. Log in at **https://open-vsx.org** with GitHub.
2. Profile menu → **"Log in with Eclipse"** — connects (or creates) an Eclipse Foundation
   account.
3. Back on the Open VSX profile page, a **"Show Publisher Agreement"** button appears. Read it
   and click **Agree**.
4. The already-published version activates automatically — no need to `ovsx publish` again.

### Publish

```bash
npx ovsx publish -p <token>     # same .vsix pipeline as vsce; runs vscode:prepublish first
```

### Verifying the publish landed

```bash
curl -s "https://open-vsx.org/api/diegosouzapw/omnicopilot"
```

`{"error":"Extension not found: ..."}` means either it hasn't propagated yet (rare — Open VSX
indexes fast) or, far more likely if you just got the "already published, but ... isn't active"
error, that the Publisher Agreement above hasn't been signed yet.

---

## 3. After both stores are live

- **Regenerate and swap the GitHub release asset** so the `.vsix` people download from
  `github.com/cheaper-inference/OmniCopilot/releases` matches what's on both stores:

  ```bash
  npx vsce package -o omnicopilot-<version>.vsix
  gh release upload v<version> omnicopilot-<version>.vsix --clobber
  gh release delete-asset v<version> <old-asset-name> --yes   # if the filename changed
  ```

- Bump `package.json` `version`, add a `CHANGELOG.md` entry, tag (`git tag v<version>`), commit
  and push **before** running either publish command — both CLIs publish whatever version is
  currently in `package.json`.
- Marketplace and Open VSX are independent registries with independent version state; a
  `vsce publish` does not touch Open VSX and vice versa. Re-run both for every release.
