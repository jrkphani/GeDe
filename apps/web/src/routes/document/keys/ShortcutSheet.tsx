import { Button, Dialog, DialogClose } from '@gede/ui';

import { rowAriaKeys, rowKeys, SHORTCUT_SECTIONS } from './shortcut-map.js';

export interface ShortcutSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus lands on close when the sheet was opened from the keyboard. */
  returnFocusTo?: HTMLElement | null | undefined;
}

/**
 * KEYS-01: the in-app shortcut sheet, grouped as the reference is. Rendered
 * from `SHORTCUT_SECTIONS` — the same table the shell binds from — so it
 * cannot list a chord the shell does not have. Esc or Close dismisses it.
 */
export function ShortcutSheet({ open, onOpenChange, returnFocusTo }: ShortcutSheetProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      description="Modifier shortcuts resolve by physical key, so they work on Tamil, Hindi and Telugu layouts."
      className="gd-keys"
      returnFocusTo={returnFocusTo}
      actions={
        <DialogClose asChild>
          <Button>Close</Button>
        </DialogClose>
      }
    >
      <div className="gd-keys__grid">
        {SHORTCUT_SECTIONS.map((section) => (
          <section key={section.group} className="gd-keys__group" aria-label={section.group}>
            <h3 className="gd-mono gd-keys__heading">{section.group}</h3>
            <dl className="gd-keys__rows">
              {section.rows.map((row) => (
                <div key={row.action} className="gd-keys__row">
                  <dt className="gd-keys__action">{row.action}</dt>
                  <dd className="gd-keys__keys" aria-keyshortcuts={rowAriaKeys(row)}>
                    {rowKeys(row).map((key, i) => (
                      <kbd key={`${key}-${String(i)}`} className="gd-keys__kbd">
                        {key}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="gd-keys__foot">Press ? any time to open this sheet.</p>
    </Dialog>
  );
}
