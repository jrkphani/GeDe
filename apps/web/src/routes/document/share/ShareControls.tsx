import { useState } from 'react';
import type { PresenceState } from '@gede/core';
import { Button, Icon } from '@gede/ui';

import type { DocumentSummary } from '../../../api/documents.js';
import type { ShareSheet as SheetModel } from '../../../api/shares.js';
import { SharedIndicator } from './SharedIndicator.js';
import { ShareSheet } from './ShareSheet.js';

export interface ShareControlsProps {
  doc: DocumentSummary;
  /** Other participants currently in the room (SHARE-05 avatars). */
  participants: readonly PresenceState[];
  /** RESP-02: the sheet opens read-only and no edit affordance renders. */
  phone: boolean;
}

/**
 * What the title row mounts through `TitleBar`'s `shareSlot`: the Shared pill
 * with stacked avatars (SHARE-05), the Share button, and the sheet it opens
 * (SHARE-01). The pill follows the record until the sheet reports a change,
 * so stopping sharing or the first invitation is reflected without a reload.
 */
export function ShareControls({ doc, participants, phone }: ShareControlsProps) {
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [sharedWithOthers, setSharedWithOthers] = useState<boolean | null>(null);
  const sharedFlag =
    doc.sharedBy !== undefined || (sharedWithOthers ?? doc.sharedWithOthers === true);

  const onChanged = (sheet: SheetModel) => {
    setSharedWithOthers(
      sheet.participants.length > 0 || sheet.invites.length > 0 || sheet.linkAccess !== 'none',
    );
  };

  return (
    <>
      <SharedIndicator sharedFlag={sharedFlag} participants={participants} />
      <Button
        ref={setTrigger}
        variant="ghost"
        size="sm"
        icon={<Icon name="share" size={13} />}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tour="share"
        onClick={() => {
          setOpen(true);
        }}
      >
        Share
      </Button>
      <ShareSheet
        docId={doc.id}
        title={doc.title}
        open={open}
        onOpenChange={setOpen}
        returnFocusTo={trigger}
        readOnly={phone}
        onChanged={onChanged}
      />
    </>
  );
}
