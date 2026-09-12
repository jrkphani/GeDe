/**
 * Rich cell journeys against the built bundle, on the component harness at
 * `/e2e/harness/richtext/` (see `src/test/e2e-harness/richtext.tsx`): the real
 * `RichCellEditor` and `CellContent` over a real, offline Yjs document. The
 * grid's own editor swap lands with the grid-editing branch; these journeys
 * cover the cell components themselves in a real contenteditable.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/test.js';

const URL = '/e2e/harness/richtext/';

/** ⌘ on Apple, Ctrl elsewhere — the editor resolves chords the same way (`isApplePlatform`). */
async function mod(page: Page): Promise<'Meta' | 'Control'> {
  const apple = await page.evaluate(() => /Macintosh|Mac OS X/.test(navigator.userAgent));
  return apple ? 'Meta' : 'Control';
}

async function open(page: Page): Promise<void> {
  await page.goto(URL);
  await expect(page.getByRole('grid', { name: 'Harness' })).toBeVisible();
}

test.describe('rich cell (harness)', () => {
  test('KEYS-05 (partial) ⌘B bolds the selection by physical key; the mark survives commit and re-render', async ({
    page,
    checkA11y,
    snapshot,
  }) => {
    await open(page);
    const m = await mod(page);
    const cell = page.locator('[data-address="A1"]');
    await cell.dblclick();
    const editor = page.getByRole('textbox', { name: 'Edit A1' });
    await expect(editor).toBeFocused();
    // The caret opens at the end; select all (triple-click, platform-neutral), then ⌘B marks all of it.
    await editor.click({ clickCount: 3 });
    await page.keyboard.press(`${m}+b`);
    await expect(editor.locator('strong')).toHaveText('Everest trek');
    await page.keyboard.press('Enter');
    await expect(editor).toBeHidden();
    await expect(cell.locator('.gd-rich strong')).toHaveText('Everest trek');
    await expect(page.getByTestId('fragment-json')).toContainText('"bold"');
    await checkA11y('rich cell at rest');
    await snapshot('rich cell bold');
  });

  test('KEYS-05 (partial) ⌘I ⌘U ⇧⌘X ⌃⌘+ ⌃⌘− each apply their mark', async ({ page }) => {
    await open(page);
    const m = await mod(page);
    const cell = page.locator('[data-address="A1"]');
    await cell.dblclick();
    const editor = page.getByRole('textbox', { name: 'Edit A1' });
    await editor.click({ clickCount: 3 });
    await page.keyboard.press(`${m}+i`);
    await page.keyboard.press(`${m}+u`);
    await page.keyboard.press(`${m}+Shift+x`);
    // ⌃⌘+ on Apple; Ctrl+Alt+= elsewhere, where Ctrl+= is zoom in (ADR-038).
    await page.keyboard.press(m === 'Meta' ? 'Control+Meta+Equal' : 'Control+Alt+Equal');
    await expect(editor.locator('em')).toHaveCount(1);
    await expect(editor.locator('u')).toHaveCount(1);
    await expect(editor.locator('s')).toHaveCount(1);
    await expect(editor.locator('sup')).toHaveCount(1);
    await page.keyboard.press(m === 'Meta' ? 'Control+Meta+Minus' : 'Control+Alt+Minus');
    await expect(editor.locator('sub')).toHaveCount(1);
    await expect(editor.locator('sup')).toHaveCount(0);
    await page.keyboard.press('Escape');
    // Escape put the cell back the way it was: no marks.
    await expect(cell.locator('.gd-rich em')).toHaveCount(0);
    await expect(cell.locator('.gd-rich')).toHaveText('Everest trek');
  });

  test('GRID-04 (partial) GRID-06 (partial) KEYS-03 typing on an armed cell overwrites; Enter opens on the text; Escape discards; ⌘Z is one step', async ({
    page,
  }) => {
    await open(page);
    const m = await mod(page);
    const cell = page.locator('[data-address="A1"]');
    await cell.focus();
    await page.keyboard.type('Annapurna');
    await expect(page.getByRole('textbox', { name: 'Edit A1' })).toHaveText('Annapurna');
    await page.keyboard.press('Enter');
    await expect(cell.locator('.gd-rich')).toHaveText('Annapurna');
    await expect(page.getByTestId('undo-depth')).toHaveText('1');
    await cell.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.type(' II');
    await expect(page.getByRole('textbox', { name: 'Edit A1' })).toHaveText('Annapurna II');
    await page.keyboard.press('Escape');
    await expect(cell.locator('.gd-rich')).toHaveText('Annapurna');
    await expect(page.getByTestId('undo-depth')).toHaveText('1');
    // KEYS-03: the overwrite was one step; ⌘Z brings the original text back.
    await cell.focus();
    await page.keyboard.press(`${m}+z`);
    await expect(cell.locator('.gd-rich')).toHaveText('Everest trek');
  });

  test('I18N-01 GRID-06 (partial) Enter does not commit while an IME is composing; it commits once composition ends', async ({
    page,
  }) => {
    await open(page);
    const cell = page.locator('[data-address="A1"]');
    await cell.dblclick();
    const editor = page.getByRole('textbox', { name: 'Edit A1' });
    await expect(editor).toBeFocused();
    // A real IME raises compositionstart before its keydowns; ProseMirror then
    // treats every keydown as part of the composition until compositionend.
    await editor.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await page.keyboard.press('Enter');
    await expect(editor).toBeVisible();
    await expect(editor).toBeFocused();
    await editor.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
    });
    await page.keyboard.press('Escape');
    await expect(editor).toBeHidden();
    await expect(cell.locator('.gd-rich')).toHaveText('Everest trek');
  });

  test('FMT-02 FMT-03 I18N-04 a Number column right-aligns and groups; Currency renders per locale with accounting negatives', async ({
    page,
  }) => {
    await open(page);
    const a2 = page.locator('[data-address="A2"] .gd-rich');
    // FMT-01: Automatic shows the text as typed, right-aligned because it is a number.
    await expect(a2).toHaveText('1234.5');
    await expect(a2).toHaveClass(/gd-rich--right/);
    await page.getByLabel('Column format').selectOption('number');
    await expect(a2).toHaveText('1,234.5');
    await expect(a2).toHaveClass(/gd-rich--right/);
    await page.getByLabel('Locale').selectOption('en-IN');
    await expect(a2).toHaveText('1,234.5');
    await page.getByLabel('Column format').selectOption('currency');
    await page.getByLabel('Currency').selectOption('INR');
    await expect(a2).toHaveText(/₹1,234\.50/);
    // Type a negative amount into A2: accounting parentheses, still right-aligned.
    await page.locator('[data-address="A2"]').focus();
    await page.keyboard.type('(1,099.5)');
    await page.keyboard.press('Enter');
    await expect(a2).toHaveText(/\(₹1,099\.50\)/);
    await expect(a2).toHaveClass(/gd-rich--right/);
    // FMT-02: the stored value is the parsed number, not the typed text.
    await expect(page.getByTestId('stored-text')).toContainText('"-1099.5"');
  });

  test('FMT-05 A11Y-04 text under a Number format is tinted, carries a warning glyph with text, and keeps its text', async ({
    page,
    checkA11y,
  }) => {
    await open(page);
    await page.getByLabel('Column format').selectOption('number');
    const a1 = page.locator('[data-address="A1"] .gd-rich');
    await expect(a1).toHaveClass(/gd-rich--invalid/);
    await expect(a1).toContainText('Everest trek');
    await expect(a1.locator('svg[data-name="warning"]')).toBeVisible();
    await expect(a1.getByText('Not a number')).toBeAttached();
    const tinted = await page
      .locator('[data-address="A1"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const plain = await page
      .locator('[data-address="A2"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(tinted).not.toBe(plain);
    await checkA11y('rich cell invalid');
  });

  test('I18N-03 an Indic cell carries lang and the 1.7 line-height', async ({ page }) => {
    await open(page);
    const a3 = page.locator('[data-address="A3"] .gd-rich');
    await expect(a3).toHaveAttribute('lang', 'ta');
    const ratio = await a3.evaluate((el) => {
      const s = getComputedStyle(el);
      return parseFloat(s.lineHeight) / parseFloat(s.fontSize);
    });
    expect(ratio).toBeGreaterThanOrEqual(1.69);
    const latin = await page.locator('[data-address="A1"] .gd-rich').evaluate((el) => {
      const s = getComputedStyle(el);
      return parseFloat(s.lineHeight) / parseFloat(s.fontSize);
    });
    expect(latin).toBeLessThan(1.5);
  });
});
