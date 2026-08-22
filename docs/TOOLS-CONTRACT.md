# Fixed Search and Rerank tool contracts

Contract evidence is grounded in OmniRoute `release/v3.8.50` endpoint contracts. The extension preserves each successful response as complete JSON text in the VS Code tool result.

| Tool | Upstream request | Local-only selection |
| --- | --- | --- |
| `omniroute_search` | `POST /v1/search`; `query` required, non-empty, at most 500 characters; optional `provider`; `max_results` 1–100 (default 5); `search_type` `web` or `news` (default `web`). | Optional public `model` becomes upstream `provider`. Optional `routeId` selects a configured extension route and is never serialized. Without overrides, the first request-local catalog candidate advertising exact `/search` support is used, with transient-only failover. |
| `omniroute_rerank` | `POST /v1/rerank`; `model` required upstream; non-empty `query`; at least one document; optional `top_n` and `return_documents`. Public documents are strings. | Optional public `model` overrides automatic selection. Otherwise a model advertising exact `/rerank` support supplies the required upstream model. `routeId` remains local. |

Both endpoint calls use the selected route's bearer credential, cancellation, a bounded non-streaming timeout, and the existing transient HTTP retry policy. Selection examines at most ten configured routes per invocation and introduces no queue, semaphore, or shared in-flight request state.
