import { Button, Icon, Menu, type MenuEntry } from '@gede/ui';
import { useRef, useState } from 'react';

import { useMessages } from '../../i18n/index.js';
import { ShortcutSheet } from '../document/keys/ShortcutSheet.js';
import { useReplayTour } from '../tour/TourController.js';

/**
 * The library's help control (ONB-08, DS "Help control (library)"): a `?`
 * ghost button before the + control, on a Radix menu with Replay guided tour
 * and Keyboard shortcuts. Inside a document `?` still opens the shortcut
 * sheet directly; the library has no document to bind that key on, so the
 * menu carries it.
 */
export function HelpMenu() {
  const t = useMessages();
  const replay = useReplayTour();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const entries: MenuEntry[] = [
    {
      kind: 'item',
      id: 'replay-tour',
      label: t('library.help.replay'),
      onSelect: replay,
    },
    {
      kind: 'item',
      id: 'shortcuts',
      label: t('library.help.shortcuts'),
      onSelect: () => {
        setShortcutsOpen(true);
      },
    },
  ];

  return (
    <>
      <Menu
        align="end"
        label={t('library.help.label')}
        entries={entries}
        trigger={
          <Button
            ref={trigger}
            variant="ghost"
            icon={<Icon name="help" size={15} />}
            aria-label={t('library.help.label')}
            title={t('library.help.label')}
            className="gd-lib__help"
            data-testid="library-help"
          />
        }
      />
      <ShortcutSheet
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        returnFocusTo={trigger.current}
      />
    </>
  );
}
