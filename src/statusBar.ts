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

/**
 * Whether the model picker should be listed again, decided from one poll to the
 * next: when this poll was accepted (a 2xx probe) and the previous one was not,
 * or there was none. A 401/403 probe means "the server is there" but the listing
 * would be refused too. Status changes reported by finished requests play no
 * part, so a refused listing cannot start a refresh loop.
 */
export function shouldRefreshModels(args: {
  previousPollOk: boolean | undefined;
  pollOk: boolean;
}): boolean {
  return args.pollOk && args.previousPollOk !== true;
}

/**
 * Icon and theme colours of the status-bar item. An online server that does not
 * get the stored key (withheld for another origin) is not shown as green: the
 * probe succeeds without a key, but chat and the model list would be refused.
 */
export function statusPresentation(args: { status: Status; keyWithheld: boolean }): {
  text: string;
  color: string | undefined;
  background: string | undefined;
} {
  switch (args.status) {
    case "online":
      return args.keyWithheld
        ? {
            text: "$(warning) OmniRoute",
            color: undefined,
            background: "statusBarItem.warningBackground",
          }
        : { text: "$(circle-filled) OmniRoute", color: "testing.iconPassed", background: undefined };
    case "offline":
      return {
        text: "$(circle-outline) OmniRoute",
        color: undefined,
        background: "statusBarItem.warningBackground",
      };
    default:
      return { text: "$(sync~spin) OmniRoute", color: undefined, background: undefined };
  }
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
  private keyWithheld = false;
  /** Whether the last poll was accepted (2xx); undefined before the first poll. */
  private lastPollOk: boolean | undefined;

  constructor(
    private readonly getClient: () => Promise<OmniRouteClient>,
    private readonly log: vscode.LogOutputChannel,
    private readonly onStatusChange?: (status: "online" | "offline") => void,
    private readonly getConnection?: () => Promise<Connection>,
    /** Called when a poll found the server accepting requests again (see `shouldRefreshModels`). */
    private readonly onModelsReachable?: () => void
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
    this.keyWithheld = connection?.keyWithheld ?? false;
    const result: ProbeResult = await client.probe(PROBE_TIMEOUT_MS);
    this.lastFailure = result.ok
      ? undefined
      : describeProbeFailure(client.baseUrl, result, PROBE_TIMEOUT_MS).summary;
    this.setStatus(result.ok ? "online" : "offline");
    const pollOk = result.ok && result.status >= 200 && result.status < 300;
    const previousPollOk = this.lastPollOk;
    this.lastPollOk = pollOk;
    if (shouldRefreshModels({ previousPollOk, pollOk })) this.onModelsReachable?.();
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
    const look = statusPresentation({ status: this.status, keyWithheld: this.keyWithheld });
    this.item.text = look.text;
    this.item.color = look.color ? new vscode.ThemeColor(look.color) : undefined;
    this.item.backgroundColor = look.background ? new vscode.ThemeColor(look.background) : undefined;
    switch (this.status) {
      case "online":
        this.item.tooltip = this.tooltip(
          vscode.l10n.t("OmniRoute online — {0}. Click for actions.", root)
        );
        break;
      case "offline":
        this.item.tooltip = this.tooltip(
          vscode.l10n.t("OmniRoute unreachable — {0}. Click for actions.", root),
          this.lastFailure
        );
        break;
      default:
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
