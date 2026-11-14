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

/** Values returned by `workspace.getConfiguration().get(key, fallback)`.
 * Keys are the bare setting names (e.g. "baseUrl"), whatever the section. */
const configValues = new Map<string, unknown>();

export function setMockConfig(values: Record<string, unknown>): void {
  configValues.clear();
  for (const [key, value] of Object.entries(values)) configValues.set(key, value);
}

export const workspace = {
  getConfiguration(_section?: string) {
    return {
      get: <T>(key: string, fallback?: T): T | undefined =>
        configValues.has(key) ? (configValues.get(key) as T) : fallback,
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

export const window = {
  showWarningMessage: async (..._args: unknown[]): Promise<undefined> => undefined,
  showInformationMessage: async (..._args: unknown[]): Promise<undefined> => undefined,
  showErrorMessage: async (..._args: unknown[]): Promise<undefined> => undefined,
};

export const commands = {
  executeCommand: async (..._args: unknown[]): Promise<undefined> => undefined,
};
