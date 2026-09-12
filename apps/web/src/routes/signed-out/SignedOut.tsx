import { useNavigate } from 'react-router';
import { Button, Wordmark } from '@gede/ui';
import { forgetLastEmail, readLastEmail } from '../../auth/session.js';
import { forgetLastDocument, readLastDocument } from '../../last-document.js';

/** Option 1c sign-out state: says what happened and what to do next. */
export function SignedOut() {
  const navigate = useNavigate();
  const lastDoc = readLastDocument();
  const lastEmail = readLastEmail();
  return (
    <main className="gd-signedout">
      <div className="gd-signedout__card">
        <Wordmark size={24} />
        <h1 className="gd-signedout__title">Signed out of GeDe</h1>
        {lastDoc ? (
          <p className="gd-signedout__doc">
            Everything in <strong>{lastDoc.title}</strong> is saved. Nothing is left on this device.
          </p>
        ) : (
          <p className="gd-signedout__doc">Everything is saved. Nothing is left on this device.</p>
        )}
        <div className="gd-signedout__actions">
          <Button
            variant="primary"
            size="lg"
            onClick={() => {
              void navigate('/sign-in');
            }}
          >
            {lastEmail !== '' ? `Sign back in as ${lastEmail}` : 'Sign back in'}
          </Button>
          <Button
            size="lg"
            onClick={() => {
              // Switch account: the next person starts from a clean sign-in.
              forgetLastEmail();
              forgetLastDocument();
              void navigate('/sign-in');
            }}
          >
            Switch account
          </Button>
        </div>
      </div>
    </main>
  );
}
