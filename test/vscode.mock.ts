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

export class LanguageModelToolResult {
  constructor(public content: unknown[]) {}
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

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => unknown> = [];
  event = (listener: (e: T) => unknown) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(data: T): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }
  dispose(): void {}
}

export const l10n = {
  t: (message: string | { message: string; args?: unknown[] }, ...args: unknown[]): string => {
    let msg = typeof message === "string" ? message : message.message;
    const finalArgs = typeof message === "object" && message.args ? message.args : args;
    finalArgs.forEach((arg, idx) => {
      msg = msg.replace(`{${idx}}`, String(arg));
    });
    return msg;
  },
};

export const secretStore = new Map<string, string>();

export const configValues: Record<string, Record<string, unknown>> = {};
export const configUpdates: Array<{ section: string; key: string; value: unknown }> = [];

export const workspace = {
  getConfiguration: (section = "") => {
    if (!configValues[section]) configValues[section] = {};
    const values = configValues[section];
    return {
      get: <T>(key: string, defaultValue?: T): T =>
        key in values ? (values[key] as T) : (defaultValue as T),
      update: (key: string, value: unknown) => {
        configUpdates.push({ section, key, value });
        values[key] = value;
        return Promise.resolve();
      },
    };
  },
};

export const commands = {
  executeCommand: async (_command: string, ..._args: unknown[]): Promise<unknown> => undefined,
};

export const registeredTools: Array<{ name: string; tool: unknown; disposed: boolean }> = [];

export const lm = {
  registerTool: (name: string, tool: unknown) => {
    const registration = { name, tool, disposed: false };
    registeredTools.push(registration);
    return { dispose: () => { registration.disposed = true; } };
  },
};

export const secretStorage = {
  async store(key: string, value: string): Promise<void> {
    secretStore.set(key, value);
  },
  async get(key: string): Promise<string | undefined> {
    return secretStore.get(key);
  },
  async delete(key: string): Promise<void> {
    secretStore.delete(key);
  },
};

class MementoMock {
  private store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    return (this.store.has(key) ? this.store.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

/** Minimal ExtensionContext stand-in for tests that touch secrets/globalState. */
export function createMockContext(): unknown {
  return {
    secrets: secretStorage,
    globalState: new MementoMock(),
    workspaceState: new MementoMock(),
    extensionUri: { scheme: "file", path: "/mock" },
    subscriptions: [],
  };
}

export class MarkdownString {
  supportThemeIcons = false;
  private parts: string[] = [];
  appendMarkdown(value: string): MarkdownString {
    this.parts.push(value);
    return this;
  }
  get value(): string {
    return this.parts.join("");
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class ThemeColor {
  constructor(public id: string) {}
}

export const window = {
  showErrorMessage: async (_message: string) => undefined,
  createStatusBarItem: (_alignment?: StatusBarAlignment, _priority?: number) => ({
    text: "",
    tooltip: "",
    command: "",
    color: undefined as ThemeColor | undefined,
    backgroundColor: undefined as ThemeColor | undefined,
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
};

