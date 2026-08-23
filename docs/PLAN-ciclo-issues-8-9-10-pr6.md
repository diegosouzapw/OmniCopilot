# Plano — ciclo issues #8/#9/#10 + PR #6

> Triage confirmada contra o código em 2026-08-19/22. Este documento é só o plano;
> implementação segue a ordem P0 → P3. Não é seguido à risca — cada P vira seu PR.
> Referências: `docs/CATALOG.md`, triagem nesta sessão, issues e PR citados.

## O mapa

| Pedido | Veredito | Dono do trabalho | Esforço |
| --- | --- | --- | --- |
| #10 "Where are the settings?" | docs/UX — a resposta existe, o repórter não achou | OmniCopilot | trivial |
| #8 Quotas por API key | **o servidor já tem tudo**; falta JSON + superfície na extensão | OmniRoute + OmniCopilot | médio |
| #9 Modelos na Agents Window | possível, com pesquisa — API experimental | OmniCopilot (+ spike) | médio |
| PR #6 multi-route | **recusar o código, aceitar a ideia**, com crédito | OmniCopilot | grande |

A decisão de arquitetura que organiza tudo: **#8 e a configuração da #10 moram no mesmo painel** —
o webview da Activity Bar. A #10 ("não achei as configurações") é um sintoma de o painel não ser
descoberto; quando ele ganha a seção de quotas, a resposta da #10 se torna visível. E o
multi-route do PR #6, quando vier, estende essa mesma superfície.

---

## P0 — #10: settings onde o usuário procura

Nenhuma feature nova. Duas mudanças de descoberta:

1. **Command palette**: registrar `OmniRoute: Open Settings` →
   `workbench.action.openSettings` com query `omnicopilot`. Hoje o caminho existe
   (`omnicopilot.manage` foca o painel) mas ninguém o encontra pelo nome "settings".
2. **Tooltip/boas-vindas do painel**: uma linha apontando File → Preferences → Settings →
   Extensions → OmniRoute para as opções sem UI no painel.

Responder à issue com o caminho + a feature de descoberta; fechar como respondida.

## P1 — #8: quotas no painel (o coração do ciclo)

### O que o servidor já entrega — e o que falta

`GET /api/usage/om-usage` (OmniRoute) é **self-service com a própria chave**: qualquer tenant
autenticado com `allowUsageCommand` lê `Personal quota` (daily/weekly $ + `resetAt`) e
`Provider quota` (session/weekly % + reset). Exatamente o que @gilfrade pediu.

**O problema: devolve `text/plain`.** A extensão precisaria fazer parse de texto, o que é
frágil. O shape estruturado já existe internamente (`ApiKeyUsageLimitStatus` +
`UsageSnapshot`) e é montado por `buildUsageCommandText()` — o caminho texto e o caminho JSON
compartilham o mesmo coletor.

### Duas pontas, na ordem

**OmniRoute (servidor):**
- Adicionar `?format=json` a `/api/usage/om-usage` (ou rota paralela), devolvendo o
  `ApiKeyUsageLimitStatus` + `UsageSnapshot` em vez do texto. Reusa `collectUsageSnapshots`
  (module-internal — exportar) e `getApiKeyUsageLimitStatus`. Sem SQL novo: o coletor já
  existe. Mesma guarda de auth (`isValidApiKey` + `allowUsageCommand`). Teste cobrindo 401 /
  403 / o shape JSON.
- Risco a verificar: `allowUsageCommand` default — se a chave do tenant médio não tiver o
  flag, o painel mostra "usage not enabled", o que é a resposta honesta.

**OmniCopilot (extensão):**
- Cliente: `getUsage()` → `GET /api/usage/om-usage?format=json` com o Bearer da conexão.
- Painel: nova seção "My usage" — daily/weekly $ consumido vs limite, % restante, reset.
  Segue o padrão já presente no painel (status → snapshot → `postMessage`). Quando o
  servidor não tem `format=json` (versões antigas), o painel degrada para esconder a seção.
- @gilfrade vê Codex/Claude/OpenCode **quando cada um é uma conexão com quota aprendida**;
  a visão por chave é a `Personal quota`.

**Teste de aceitação (a resposta exata da issue):** "vejo OpenCode Go limits mas 0% em todos
os intervalos; Codex e Claude não aparecem". Reproduzir contra a `.17` — provável causa: a
chave do repórter não tem `allowUsageCommand`, ou Codex/Claude não têm quota aprendida nessa
conexão. A resposta muda conforme o achado; o painel deve tornar o motivo visível em vez de 0%.

## P2 — #9: Agents Window (pesquisa primeiro)

Premissa do repórter confirmada. O caminho é registrar o provider com
`targetChatSessionType: "copilotcli"` (API de runtime — o JSON estático não aceita o campo) e
o usuário habilitar `chat.agentHost.byokModels.enabled` (experimental).

**Mas é experimental e não está nos typings da 1.104** — vai exigir cast e quebra com mudança
do VS Code. Então a ordem é spike antes do feature:

1. **Spike (sem compromisso)**: registra um segundo provider com `targetChatSessionType`,
   mede contra um VS Code real com a flag experimental ligada. Saída: aparece na Agents
   Window? tool calling funciona lá? Documentar a resposta.
2. **Feature (se o spike for verde)**: registro duplo — o provider normal mais um mirror com
   o session-type da Agents Window. Atrás de um setting `omnicopilot.exposeToAgentsWindow`
   default **off**, por ser experimental. Modelos exigem tool calling para aparecer — o filtro
   já existe no catalogFilter.
3. Responder ao repórter (@Bulzi-Robb se ofereceu para testar preview) com o resultado do
   spike antes de shippar.

## P3 — PR #6: a ideia, não o código

A decisão do /port é **reimplementar, creditando @atmediallc**, não cherry-pick nem merge.
Motivo: o branch dele é um bloco monolítico (+13.530/−1.204) cujos defeitos são
estruturais — não se resolvem editando:

- **Dez vendors com o mesmo `displayName`** — a solução é `when` no contribution point, que é
  uma forma diferente de escrever, não uma emenda.
- **`managementCommand` removido sem substituto** — a doc manda `configuration` (com
  `"secret": true`), e a migração é trabalho próprio.
- **pnpm-lock + docs de planejamento** não pertencem ao repo.
- **Colide com a 1.1.0** no reasoning effort.

O que se aproveita é o **design**: multi-route com modelos prefixados por rota, fallback que
cruza servidores, métricas de token na status bar. Isso entra como um roadmap de três fases
no painel/Cliente, com `Co-authored-by: atmediallc <…>` nos commits e um comentário na PR
explicando que a ideia vira roadmap e ele é co-autor. Fechar a PR #6 apontando para o roadmap.

Multi-route só depois do painel ter quota (#8): a superfície multi-servidor estende o painel
que a #8 constrói.

---

## Ordem e dependências

```
P0 (#10 descoberta) ──┐
                      ├─→ o mesmo painel
P1 (#8 quotas)      ──┘     └─→ P3 multi-route estende o painel
P2 (#9 agents window — spike)   independente, em paralelo ao P1
```

1. P0 primeiro (trivial, destrava a resposta da #10).
2. P1 é o coração — duas pontas, servidor antes da extensão (a extensão depende do JSON).
3. P2 em paralelo ao P1: spike independente, sem bloquear.
4. P3 por último e separado — é o maior e depende do painel da P1.

Cada P vira um PR próprio. Nenhum merge sem o dono.
