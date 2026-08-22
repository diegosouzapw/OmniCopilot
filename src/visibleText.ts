const INVISIBLE_TEXT = /[\s\p{Cc}\p{Cf}]/gu;

/** Returns whether text contains content that can produce a visible glyph. */
export function containsVisibleText(text: string): boolean {
  return text.replace(INVISIBLE_TEXT, "").length > 0;
}
