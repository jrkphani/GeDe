/**
 * Script detection for a cell's text (I18N-03). The root carries `lang` for
 * the active locale, but a Tamil string in an en-US workbook still needs the
 * Noto fallback and the 1.7 line-height so its matras are not clipped; the
 * renderer sets `lang` per cell from what the text actually contains.
 */

export type IndicLang = 'ta' | 'hi' | 'te';

const SCRIPTS: readonly { readonly lang: IndicLang; readonly re: RegExp }[] = [
  { lang: 'ta', re: /\p{Script=Tamil}/u },
  { lang: 'hi', re: /\p{Script=Devanagari}/u },
  { lang: 'te', re: /\p{Script=Telugu}/u },
];

/**
 * The first Indic script found in the text, or null for Latin, digits and
 * punctuation only. Mixed-script text takes the script of its first Indic
 * character; the line-height rule is the same for all three.
 */
export function detectIndicLang(text: string): IndicLang | null {
  let best: { lang: IndicLang; at: number } | null = null;
  for (const { lang, re } of SCRIPTS) {
    const m = re.exec(text);
    if (m !== null && (best === null || m.index < best.at)) best = { lang, at: m.index };
  }
  return best?.lang ?? null;
}
