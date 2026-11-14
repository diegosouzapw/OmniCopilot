/** Chat Completions rejects tool names longer than this (OpenAI and several
 * upstream providers behind the gateway). MCP tool names routinely exceed it. */
export const MAX_TOOL_NAME_LENGTH = 64;

export interface ToolNameAliases {
  /** Name to put on the wire for an editor-side tool name. */
  toWire(name: string): string;
  /** Editor-side name for a name received from the wire (unknown names pass through). */
  fromWire(wireName: string): string;
}

/** 32-bit FNV-1a over the UTF-8 bytes of `text`, as 8 lowercase hex digits. */
function fnv1a32Hex(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** `name` itself when it fits; otherwise a deterministic shortened form
 * `<prefix>_<8 hex digits of the name's hash>` that is exactly `maxLength` long. */
export function aliasToolName(name: string, maxLength: number = MAX_TOOL_NAME_LENGTH): string {
  if (name.length <= maxLength) return name;
  return `${name.slice(0, maxLength - 9)}_${fnv1a32Hex(name)}`;
}

/** Remembers the way back for every name it is given, so tool calls streamed
 * from the gateway can be reported to the editor under their original name. */
export function createToolNameAliases(
  names: Iterable<string>,
  maxLength: number = MAX_TOOL_NAME_LENGTH
): ToolNameAliases {
  const originals = new Map<string, string>();
  const toWire = (name: string): string => {
    const wire = aliasToolName(name, maxLength);
    if (wire !== name && !originals.has(wire)) originals.set(wire, name);
    return wire;
  };
  for (const name of names) toWire(name);
  return {
    toWire,
    fromWire: (wireName) => originals.get(wireName) ?? wireName,
  };
}
