import { Avatar, Button, Menu, type MenuEntry } from '@gede/ui';
import { announce } from '../../announce.js';
import { updateMe } from '../../api/me.js';
import type { SessionUser } from '../../auth/cognito.js';
import {
  isLocale,
  languageOf,
  LOCALE_LABELS,
  LOCALE_NAMES,
  LOCALES,
  useLocale,
} from '../../locale.js';

export interface AccountMenuProps {
  user: SessionUser;
  onSignOut: () => void;
}

/**
 * Account menu on the library chrome: who is signed in, the locale picker
 * (I18N-05 — one choice drives `lang`, collation and formatting), sign out.
 */
export function AccountMenu({ user, onSignOut }: AccountMenuProps) {
  const [locale, setLocale] = useLocale();
  const displayName = user.name ?? user.email;

  const changeLocale = (value: string) => {
    if (!isLocale(value) || value === locale) return;
    setLocale(value);
    announce(`Language set to ${LOCALE_LABELS[value]}`);
    // Mirror the choice to the account so other devices follow (I18N-05).
    updateMe({ locale: value }).catch(() => {
      announce('Language saved on this device only; the account could not be updated');
    });
  };

  const entries: MenuEntry[] = [
    {
      kind: 'item',
      id: 'who',
      label: user.email,
      onSelect: () => undefined,
      disabledReason: `Signed in as ${user.email}`,
    },
    { kind: 'separator', id: 's1' },
    {
      kind: 'radio',
      id: 'locale',
      label: 'Language and formats',
      value: locale,
      onValueChange: changeLocale,
      // WCAG 3.1.2: each autonym carries its own language so a screen reader switches
      // voice for தமிழ் / हिन्दी / తెలుగు instead of reading them with the UI voice.
      options: LOCALES.map((l) => ({
        value: l,
        label: (
          <>
            <span lang={languageOf(l)}>{LOCALE_NAMES[l].autonym}</span> ({LOCALE_NAMES[l].region})
          </>
        ),
      })),
    },
    { kind: 'separator', id: 's2' },
    { kind: 'item', id: 'signout', label: 'Sign out', onSelect: onSignOut },
  ];

  return (
    <Menu
      align="end"
      label="Account"
      entries={entries}
      trigger={
        <Button
          variant="ghost"
          className="gd-lib__account"
          icon={<Avatar name={displayName} size={24} decorative />}
          aria-label={`Account: ${displayName}`}
          title="Account"
        />
      }
    />
  );
}
