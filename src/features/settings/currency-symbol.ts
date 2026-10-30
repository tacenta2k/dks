/**
 * Direction for the currency-symbol field (Settings → Workspace).
 *
 * The symbol is stored as a *logical* string and is never reordered, reversed,
 * or decorated with bidi control characters. The Omani Rial default is four
 * characters:
 *
 *   U+0631 ARABIC LETTER REH
 *   U+002E FULL STOP
 *   U+0639 ARABIC LETTER AIN
 *   U+002E FULL STOP
 *
 * Rendered in an LTR paragraph — the surrounding Settings form — the Unicode
 * Bidirectional Algorithm resolves the trailing full stop in the embedding
 * direction (LTR), so it is displayed at the wrong end and the whole symbol
 * reads reversed ("ع.ر." on screen instead of "ر.ع."). Resolving the field's own
 * direction from its first strong character puts all four characters into one
 * RTL run, so the trailing full stop is displayed last and the symbol reads
 * correctly, right to left.
 *
 * That is exactly what `dir="auto"` does in a browser; it is resolved here in
 * one small function so the behaviour is deterministic across engines and
 * provable in the unit tests (jsdom does not implement the bidi algorithm).
 * It mirrors the first-strong-character rule:
 *
 *   - first strong character is Arabic/Hebrew (bidi R or AL) → RTL;
 *   - first strong character is any other letter (bidi L) → LTR;
 *   - no strong character at all (`$`, `€`, digits, empty) → LTR, the direction
 *     of the surrounding form.
 *
 * The value itself is returned untouched by every caller: this module only ever
 * decides the paragraph direction of the input, never the characters in it.
 */

/**
 * Letters of the scripts whose strong characters are bidi class R/AL.
 *
 * Script properties (not raw blocks) keep this precise: Arabic-Indic digits
 * (١٢٣) and Arabic combining marks live in the same blocks but are not strong
 * — digits take the direction of the surrounding text, so `١٢٣` must not flip
 * the field. The Arabic Presentation Forms have `Script=Arabic` too.
 */
const RTL_SCRIPT_LETTER = new RegExp(
  '['
  + '\\p{Script=Arabic}\\p{Script=Hebrew}\\p{Script=Syriac}\\p{Script=Thaana}'
  + '\\p{Script=Nko}\\p{Script=Samaritan}\\p{Script=Mandaic}'
  + ']',
  'u',
);

/** Any letter: every letter outside the RTL scripts is bidi class L. */
const ANY_LETTER = /\p{L}/u;

export type CurrencySymbolDirection = 'rtl' | 'ltr';

/**
 * Paragraph direction for a currency symbol, from its first strong character.
 * Pure: no locale, no DOM, no mutation of the input.
 */
export function currencySymbolDirection(value: string): CurrencySymbolDirection {
  // for…of iterates code points, so astral characters cannot split a surrogate
  // pair into a false match.
  for (const character of String(value ?? '')) {
    if (!ANY_LETTER.test(character)) {
      // Punctuation, digits, spaces and symbols such as $ or € are not strong:
      // they take the direction of the surrounding text, so keep looking.
      continue;
    }
    return RTL_SCRIPT_LETTER.test(character) ? 'rtl' : 'ltr';
  }
  return 'ltr';
}

/** The stored symbol as code points, for exactness tests and diagnostics. */
export function currencySymbolCodePoints(value: string): string[] {
  return Array.from(String(value ?? ''), (character) => (
    `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
  ));
}
