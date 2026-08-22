import * as vscode from "vscode";
import { getClientForRoute } from "./routes";
import type { Route } from "./routes";
import type { MetricsTracker } from "./metrics";
import {
  renderStatusText,
  statusColorTokens,
  type StatusKind,
  type StatusSnapshot,
} from "./status/statusRenderer";
import { buildStatusTooltip } from "./status/statusTooltip";
import type { ResolvedChatUsage } from "./usage";

export type ChatUsage = ResolvedChatUsage;
type Status = StatusKind;

interface ServerHealth {
  routeId: string;
  name: string;
  online: boolean;
  latencyMs?: number;
}

/** After this idle period without new usage the token readout is cleared. */
const USAGE_STALE_MS = 60_000;

/** Status-bar "dot": green when every OmniRoute server answers the HEAD
 * /v1/models probe, amber when only some do, red when none do. Also shows
 * how many servers are up and a live token readout. Hover → per-server health
 * plus the latest usage (what model, which server, how many tokens).
 * Click → quick status popup window. */
export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private usageTimer: ReturnType<typeof setTimeout> | undefined;
  private recheckTimer: ReturnType<typeof setTimeout> | undefined;
  private status: Status = "checking";
  private health: ServerHealth[] = [];
  private usage: ChatUsage | undefined;
  private readonly lastActive = new Map<string, number>();
  private disposed = false;
  /** Guards overlapping checkNow() runs so a slow probe can't stack pings. */
  private checking = false;
  /** In-flight chat requests across all provider slots. */
  private activeRequestCount = 0;
  /** Model currently streaming (set by the provider at request start). */
  private activeModel: string | undefined;
  /** Final failure message of the last request, when it errored out. */
  private lastError: string | undefined;
  /** Timestamp of the last successful response (relative-time readout). */
  private lastResponseAt: number | undefined;
  /** Fallback servers used by the last request (status-bar diagnosis). */
  private fallbackCount = 0;
  /** Consecutive all-offline probes; drives the health-check backoff. */
  private consecutiveFailures = 0;
  /** Result of the most recent completed probe (coalescing stack guard). */
  private lastCheckOk = false;
  private loopTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly snapshotChanged = new vscode.EventEmitter<StatusSnapshot>();

  constructor(
    private readonly getRoutes: () => Promise<Route[]>,
    private readonly log: vscode.LogOutputChannel,
    private readonly metricsTracker?: MetricsTracker
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.name = "OmniRoute";
    this.item.command = "omnicopilot.showStatusPopup";
    this.render();
  }

  start(): void {
    this.applyVisibility();
    this.scheduleNext();
    void this.checkNow();
  }

  /** Feed request outcomes from the provider so the dot reacts instantly per route. */
  reportActivity(ok: boolean, routeId?: string): void {
    if (this.disposed) return;
    if (!routeId) {
      if (ok) {
        this.setStatus("online");
      } else {
        void this.checkNow();
      }
      return;
    }
    if (ok) this.lastActive.set(routeId, Date.now());
    this.updateRouteHealth(routeId, ok);
    void this.metricsTracker?.recordActivity(routeId, this.serverNameFor(routeId), "", ok);
    // Let a fresh probe confirm the new state right away (300ms debounce
    // coalesces bursts of onActivity from model discovery).
    this.scheduleRecheck();
  }

  /** Display name for a route: falls back to the routeId when unnamed. */
  private serverNameFor(routeId: string): string {
    const known = this.health.find((h) => h.routeId === routeId);
    return known?.name && known.name !== routeId ? known.name : routeId;
  }

  /** True when this route answered successfully within the last 15s — lets
   * transient 503/429 under load keep the dot green instead of flickering. */
  private wasRecentlyActive(routeId: string): boolean {
    return this.lastActive.has(routeId) &&
      Date.now() - (this.lastActive.get(routeId) ?? 0) < 15_000;
  }

  /** Merge a route outcome into the health roster and re-derive the dot. */
  private updateRouteHealth(routeId: string, ok: boolean): void {
    const existing = this.health.find((h) => h.routeId === routeId);
    // Grace period: don't flip a route to offline if it was active
    // within the last 15s — transient 503/429 under load shouldn't
    // cause the status dot to flicker.
    const recentlyOk = !ok && this.wasRecentlyActive(routeId);
    if (existing) {
      existing.online = recentlyOk ? existing.online : ok;
    } else {
      this.health.push({ routeId, name: routeId, online: recentlyOk || ok });
    }
    this.setStatus(this.overallStatus());
  }

  /** Dot color from the current roster: all up → online, some → partial,
   * none → offline. Empty roster reports online (no known servers). */
  private overallStatus(): Status {
    const online = this.health.filter((h) => h.online).length;
    if (online === this.health.length) return "online";
    if (online > 0) return "partial";
    return "offline";
  }

  /** Connection state from the roster: empty → checking, all up → online,
   * some → partial, none → offline. */
  private connectionState(): Status {
    if (this.health.length === 0) return "checking";
    return this.overallStatus();
  }

  /** Live token usage from a streaming chat round-trip. */
  reportUsage(usage: ChatUsage): void {
    if (this.disposed) return;
    this.usage = usage;
    if (usage.routeId) {
      void this.metricsTracker?.recordUsage({
        ...usage,
        routeId: usage.routeId,
        baseUrl: usage.baseUrl ?? "",
      });
    }
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.usageTimer = setTimeout(() => {
      this.usage = undefined;
      if (!this.disposed) this.render();
    }, USAGE_STALE_MS);
    this.render();
    this.scheduleRecheck();
  }

  /** A chat request started streaming: flip the dot to a live "responding"
   * state and record which model is being served. */
  reportRequestStart(routeId: string | undefined, modelName: string): void {
    if (this.disposed) return;
    this.activeRequestCount += 1;
    this.activeModel = modelName;
    if (routeId) this.lastActive.set(routeId, Date.now());
    this.setStatus("streaming");
  }

  /** A chat request settled. `error` carries the surfaced failure message;
   * `fallbacksUsed` counts servers tried before the one that succeeded (or
   * that exhausted the chain). */
  reportRequestEnd(ok: boolean, error: string | undefined, fallbacksUsed = 0): void {
    if (this.disposed) return;
    this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
    this.fallbackCount = fallbacksUsed;
    if (this.activeRequestCount > 0) {
      this.render();
      return;
    }
    if (ok) {
      this.lastResponseAt = Date.now();
      this.lastError = undefined;
      this.activeModel = undefined;
      this.setStatus(this.connectionState());
    } else {
      this.lastError = error;
      this.activeModel = undefined;
      if (error) {
        this.setStatus("error");
      } else {
        // Cancel/abort without a failure message: fall back to the last
        // known connection state instead of painting the dot red.
        this.setStatus(this.connectionState());
      }
    }
    this.render();
    this.scheduleRecheck();
  }

  /** Debounced fresh probe after activity, so the dot tracks reality in near
   * real time without spamming HEADs mid-chat. */
  private scheduleRecheck(): void {
    if (this.disposed) return;
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    // Wait 2s after the last activity before probing — avoids pinging
    // while the server is still processing the next request.
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = undefined;
      void this.checkNow();
    }, 2000);
  }

  async checkNow(): Promise<boolean> {
    if (this.checking) return this.lastCheckOk;
    // Skip health probes while a chat response is streaming — the server
    // is alive (we're receiving data) and the ping competes for resources.
    if (this.activeRequestCount > 0) return this.lastCheckOk;
    this.checking = true;
    try {
      const routes = await this.getRoutes();
      if (routes.length === 0) {
        this.health = [];
        this.consecutiveFailures += 1;
        this.lastCheckOk = false;
        this.setStatus("offline");
        this.scheduleNext();
        return false;
      }
      const health = await Promise.all(
        routes.map(async (r) => {
          const client = getClientForRoute(r, this.log);
          const t0 = Date.now();
          let online = await client.ping(5000);
          const latencyMs = Date.now() - t0;
          // Grace: if the ping failed but we got a successful chat response
          // from this route within the last 15s, keep it marked online —
          // the server is alive but busy.
          if (!online && this.lastActive.has(r.id) &&
              Date.now() - (this.lastActive.get(r.id) ?? 0) < 15_000) {
            this.log.info(`[PING] ${r.name}: failed but recently active — keeping online`);
            online = true;
          }
          void this.metricsTracker?.recordActivity(r.id, r.name, r.baseUrl, online);
          return { routeId: r.id, name: r.name, online, latencyMs };
        })
      );
      this.health = health;
      const ok = this.health.filter((h) => h.online).length;
      this.consecutiveFailures = ok > 0 ? 0 : this.consecutiveFailures + 1;
      this.lastCheckOk = ok > 0;
      this.setStatus(this.overallStatus());
      this.scheduleNext();
      return ok > 0;
    } finally {
      this.checking = false;
    }
  }

  /** routeIds that answered the most recent liveness probe. Used by the chat
   * provider to deprioritize servers that were just unreachable, so a dead
   * proxy isn't tried first on every request. */
  onlineRouteIds(): ReadonlySet<string> {
    return new Set(this.health.filter((h) => h.online).map((h) => h.routeId));
  }

  restart(): void {
    this.applyVisibility();
    this.scheduleNext();
    void this.checkNow();
  }

  private applyVisibility(): void {
    const enabled = vscode.workspace.getConfiguration("omnicopilot").get<boolean>("statusBar", true);
    if (enabled) this.item.show();
    else this.item.hide();
  }

  /** Self-rescheduling probe loop. While every server is offline the interval
   * backs off exponentially (10→20→40→80→120s cap) so an unreachable fleet
   * isn't hammered with HEADs; it recovers instantly once a probe succeeds. */
  private scheduleNext(): void {
    if (this.disposed) return;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    const seconds = vscode.workspace
      .getConfiguration("omnicopilot")
      .get<number>("healthCheckIntervalSeconds", 30);
    const base = Math.max(seconds, 5) * 1000;
    const multiplier = this.consecutiveFailures >= 2
      ? Math.pow(2, Math.min(this.consecutiveFailures - 1, 4))
      : 1;
    const delay = Math.min(base * multiplier, 120_000);
    this.loopTimer = setTimeout(() => void this.checkNow(), delay);
  }

  /** Debounce timer for negative status transitions. */
  private offlineDebounce: ReturnType<typeof setTimeout> | undefined;

  private setStatus(status: Status): void {
    if (this.disposed || status === this.status) {
      if (!this.disposed) this.render();
      return;
    }
    // Positive transitions (→ online/streaming) apply instantly.
    // Negative transitions (online → offline/partial/error) are debounced
    // so transient ping failures don't cause the dot to flicker.
    const isNegative = (status === "offline" || status === "partial" || status === "error") &&
      (this.status === "online" || this.status === "streaming");
    if (isNegative) {
      if (!this.offlineDebounce) {
        this.offlineDebounce = setTimeout(() => {
          this.offlineDebounce = undefined;
          this.status = status;
          this.log.info(`OmniRoute connection: ${status}`);
          this.render();
        }, 3000);
      }
      return;
    }
    // Positive status clears any pending negative transition.
    if (this.offlineDebounce) {
      clearTimeout(this.offlineDebounce);
      this.offlineDebounce = undefined;
    }
    this.status = status;
    this.log.info(`OmniRoute connection: ${status}`);
    this.render();
  }

  private render(): void {
    const snap = this.snapshot();
    this.snapshotChanged.fire(snap);
    const main = this.mainLabel(snap.status);
    this.item.text = renderStatusText(snap);
    const tokens = statusColorTokens(snap);
    this.item.color = tokens.color ? new vscode.ThemeColor(tokens.color) : undefined;
    this.item.backgroundColor = tokens.background ? new vscode.ThemeColor(tokens.background) : undefined;

    const metrics = this.metricsTracker?.getMetrics();
    this.item.tooltip = buildStatusTooltip(
      snap,
      main,
      metrics
        ? {
            totalTokens: metrics.totalTokens,
            totalInputTokens: metrics.totalInputTokens,
            totalOutputTokens: metrics.totalOutputTokens,
            totalCachedTokens: metrics.totalCachedTokens ?? 0,
            totalReasoningTokens: metrics.totalReasoningTokens ?? 0,
            inputTokenProvenance: metrics.inputTokenProvenance,
            outputTokenProvenance: metrics.outputTokenProvenance,
            totalRequests: metrics.totalRequests,
          }
        : undefined
    );
  }

  /** Pure state handed to the renderer — the adapter keeps no formatting. */
  public snapshot(): StatusSnapshot {
    const serverMetrics = this.metricsTracker?.getMetrics().servers ?? {};
    return {
      status: this.status,
      servers: this.health.map((h) => ({
        routeId: h.routeId,
        name: h.name,
        online: h.online,
        latencyMs: h.latencyMs,
        tokens: serverMetrics[h.routeId]?.totalTokens ?? 0,
        requests: serverMetrics[h.routeId]?.requestCount ?? 0,
      })),
      usage: this.usage
        ? {
            serverName: this.usage.serverName,
            modelName: this.usage.modelName,
            inputTokens: this.usage.inputTokens,
            outputTokens: this.usage.outputTokens,
            cachedTokens: this.usage.cachedTokens,
            reasoningTokens: this.usage.reasoningTokens,
            inputTokenProvenance: this.usage.inputTokenProvenance,
            outputTokenProvenance: this.usage.outputTokenProvenance,
          }
        : undefined,
      lastError: this.lastError,
      lastResponseAt: this.lastResponseAt,
      activeRequestCount: this.activeRequestCount,
      activeModel: this.activeModel,
      fallbackCount: this.fallbackCount,
    };
  }

  private mainLabel(status: Status): string {
    switch (status) {

      case "online":
        return vscode.l10n.t("All OmniRoute servers online.");
      case "partial":
        return vscode.l10n.t("Some OmniRoute servers unreachable.");
      case "offline":
        return vscode.l10n.t("OmniRoute unreachable.");
      case "streaming":
        return vscode.l10n.t("OmniRoute is responding…");
      case "error":
        return this.lastError
          ? vscode.l10n.t("OmniRoute request failed: {0}", this.lastError)
          : vscode.l10n.t("OmniRoute request failed.");
      default:
        return vscode.l10n.t("Checking OmniRoute connection…");
    }
  }

  public getSnapshot(): StatusSnapshot {
    return this.snapshot();
  }

  public onDidChangeSnapshot(listener: (snapshot: StatusSnapshot) => void): vscode.Disposable {
    return this.snapshotChanged.event(listener);
  }

  dispose(): void {
    this.disposed = true;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    if (this.usageTimer) clearTimeout(this.usageTimer);
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    if (this.offlineDebounce) clearTimeout(this.offlineDebounce);
    this.item.dispose();
    this.snapshotChanged.dispose();
  }
}