/**
 * HTML escaping for everything a person or a document could have typed: names, titles,
 * addresses, links (#76 review: a title of `<b>bold</b> & co` reaches the HTML part as
 * text). Also `'`, so an escaped value is safe inside a single-quoted attribute too.
 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
