/** Minimal stand-in for the "vscode" module so convert.ts can run under vitest.
 * Mirrors only the classes/enums the conversion layer touches. */

export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
  System = 3,
}

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[]
  ) {}
}

export class LanguageModelDataPart {
  constructor(
    public data: Uint8Array,
    public mimeType: string
  ) {}

  static image(data: Uint8Array, mimeType: string): LanguageModelDataPart {
    return new LanguageModelDataPart(data, mimeType);
  }
}

export enum LanguageModelChatToolMode {
  Auto = 1,
  Required = 2,
}

export class LanguageModelThinkingPart {
  constructor(
    public value: string | string[],
    public id?: string,
    public metadata?: Record<string, unknown>
  ) {}
}

export class ThemeIcon {
  constructor(public id: string) {}
}

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => unknown>();

  readonly event = (listener: (e: T) => unknown): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(data: T): void {
    for (const listener of [...this.listeners]) listener(data);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** User-level values: `inspect(key).globalValue`, and what `get(key, fallback)`
 * returns unless `setMockInspect` gives a workspace or folder value.
 * Keys are the bare setting names (e.g. "baseUrl"), whatever the section. */
const configValues = new Map<string, unknown>();
/** Extra fields of `inspect(key)`: workspace, folder, language and default values. */
const inspectValues = new Map<string, Record<string, unknown>>();
/** Every `update()` call, in order. */
export const configUpdates: Array<{ key: string; value: unknown; target: unknown }> = [];

/** Replace the user-level values; also clears `setMockInspect` and `configUpdates`. */
export function setMockConfig(values: Record<string, unknown>): void {
  configValues.clear();
  inspectValues.clear();
  configUpdates.length = 0;
  for (const [key, value] of Object.entries(values)) configValues.set(key, value);
}

/** Set the non-user fields `inspect(key)` reports (e.g. `workspaceValue`). */
export function setMockInspect(key: string, values: Record<string, unknown>): void {
  inspectValues.set(key, values);
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export const workspace = {
  getConfiguration(_section?: string) {
    return {
      // Like VS Code: a folder value wins over a workspace value, which wins over
      // the user-level value.
      get: <T>(key: string, fallback?: T): T | undefined => {
        const extra = inspectValues.get(key) ?? {};
        if (extra.workspaceFolderValue !== undefined) return extra.workspaceFolderValue as T;
        if (extra.workspaceValue !== undefined) return extra.workspaceValue as T;
        return configValues.has(key) ? (configValues.get(key) as T) : fallback;
      },
      inspect: (key: string) => ({
        key,
        ...(configValues.has(key) ? { globalValue: configValues.get(key) } : {}),
        ...inspectValues.get(key),
      }),
      update: async (key: string, value: unknown, target?: unknown): Promise<void> => {
        configUpdates.push({ key, value, target });
        configValues.set(key, value);
      },
    };
  },
};

export const l10n = {
  t(source: string, ...args: unknown[]): string {
    return source.replace(/\{(\d+)\}/g, (match, index: string) =>
      Number(index) < args.length ? String(args[Number(index)]) : match
    );
  },
};

export class ThemeColor {
  constructor(public id: string) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

/** A status-bar item that only records what was set on it. */
function createStatusBarItem() {
  return {
    name: "",
    text: "",
    tooltip: undefined as unknown,
    command: undefined as unknown,
    color: undefined as unknown,
    backgroundColor: undefined as unknown,
    visible: false,
    show() {
      this.visible = true;
    },
    hide() {
      this.visible = false;
    },
    dispose() {},
  };
}

export const env = {
  remoteName: undefined as string | undefined,
};

export const window = {
  createStatusBarItem: (..._args: unknown[]) => createStatusBarItem(),
  showWarningMessage: async (..._args: unknown[]): Promise<undefined> => undefined,
  showInformationMessage: async (..._args: unknown[]): Promise<undefined> => undefined,
  showErrorMessage: async (..._args: unknown[]): Promise<undefined> => undefined,
};

export const commands = {
  executeCommand: async (..._args: unknown[]): Promise<undefined> => undefined,
};
