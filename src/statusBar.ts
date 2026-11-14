import * as vscode from "vscode";
import { DEFAULT_BASE_URL, OmniRouteClient, serverRootUrl } from "./client";
import { describeProbeFailure, keyWithheldMessage, type Connection } from "./connection";
import type { ProbeResult } from "./diagnostics";

const PROBE_TIMEOUT_MS = 4000;

type Status = "online" | "offline" | "checking";

/** The status after a check, calling `notify` only when it actually changed. */
export function applyStatus(
  current: Status,
  next: "online" | "offline",
  notify?: (status: "online" | "offline") => void
): Status {
  if (next !== current) notify?.(next);
  return next;
}

/** Status-bar "dot": green when the OmniRoute server answers the HEAD
 * /v1/models probe, red when it does not. Click → quick actions menu. */
export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private status: Status = "checking";
  private disposed = false;
  private lastFailure: string | undefined;
  private keyNote: string | undefined;

  constructor(
    private readonly getClient: () => Promise<OmniRouteClient>,
    private readonly log: vscode.LogOutputChannel,
    private readonly onStatusChange?: (status: "online" | "offline") => void,
    private readonly getConnection?: () => Promise<Connection>
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.name = "OmniRoute";
    this.item.command = "omnicopilot.quickActions";
    this.render();
  }

  start(): void {
    this.applyVisibility();
    this.scheduleLoop();
    void this.checkNow();
  }

  /** Feed request outcomes from the provider so the dot reacts instantly. */
  reportActivity(ok: boolean): void {
    if (ok) this.lastFailure = undefined;
    this.setStatus(ok ? "online" : "offline");
  }

  /** Why the last check failed, in one sentence; undefined while the server answers. */
  get failureSummary(): string | undefined {
    return this.status === "offline" ? this.lastFailure : undefined;
  }

  async checkNow(): Promise<boolean> {
    const client = await this.getClient();
    const connection = await this.getConnection?.();
    this.keyNote = connection ? keyWithheldMessage(connection) : undefined;
    const result: ProbeResult = await client.probe(PROBE_TIMEOUT_MS);
    this.lastFailure = result.ok
      ? undefined
      : describeProbeFailure(client.baseUrl, result, PROBE_TIMEOUT_MS).summary;
    this.setStatus(result.ok ? "online" : "offline");
    return result.ok;
  }

  restart(): void {
    this.applyVisibility();
    this.scheduleLoop();
    void this.checkNow();
  }

  private applyVisibility(): void {
    const enabled = vscode.workspace.getConfiguration("omnicopilot").get<boolean>("statusBar", true);
    if (enabled) this.item.show();
    else this.item.hide();
  }

  private scheduleLoop(): void {
    if (this.timer) clearInterval(this.timer);
    const seconds = vscode.workspace
      .getConfiguration("omnicopilot")
      .get<number>("healthCheckIntervalSeconds", 30);
    this.timer = setInterval(() => void this.checkNow(), Math.max(seconds, 5) * 1000);
  }

  private setStatus(status: "online" | "offline"): void {
    if (this.disposed) return;
    this.status = applyStatus(this.status, status, (s) => {
      this.log.info(`OmniRoute connection: ${s}`);
      this.onStatusChange?.(s);
    });
    this.render();
  }

  private render(): void {
    const cfg = vscode.workspace.getConfiguration("omnicopilot");
    const root = serverRootUrl(cfg.get<string>("baseUrl", DEFAULT_BASE_URL));
    switch (this.status) {
      case "online":
        this.item.text = "$(circle-filled) OmniRoute";
        this.item.color = new vscode.ThemeColor("testing.iconPassed");
        this.item.backgroundColor = undefined;
        this.item.tooltip = this.tooltip(
          vscode.l10n.t("OmniRoute online — {0}. Click for actions.", root)
        );
        break;
      case "offline":
        this.item.text = "$(circle-outline) OmniRoute";
        this.item.color = undefined;
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        this.item.tooltip = this.tooltip(
          vscode.l10n.t("OmniRoute unreachable — {0}. Click for actions.", root),
          this.lastFailure
        );
        break;
      default:
        this.item.text = "$(sync~spin) OmniRoute";
        this.item.color = undefined;
        this.item.backgroundColor = undefined;
        this.item.tooltip = vscode.l10n.t("Checking OmniRoute connection…");
    }
  }

  private tooltip(...lines: Array<string | undefined>): string {
    return [...lines, this.keyNote].filter((line): line is string => Boolean(line)).join("\n");
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }
}
