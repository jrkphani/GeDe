import type * as Y from 'yjs';
import { Banner, Button } from '@gede/ui';

import { engineFor, useEngineStatus } from '../../../doc/engine.js';

/**
 * ARCHITECTURE-DIGEST §3: a background operation that failed is a banner.
 * The formula Worker is restarted on its own; only once restarts are used
 * up does the document say that formulas have stopped, with a Retry.
 */
export function FormulaEngineBanner({ doc }: { doc: Y.Doc }) {
  const status = useEngineStatus(doc);
  if (!status.failed) return null;
  return (
    <Banner
      cause="Formulas stopped evaluating."
      remedy="The formula engine failed repeatedly. Cell text is safe; results will not update until it restarts."
      action={
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            engineFor(doc).retry();
          }}
        >
          Retry
        </Button>
      }
    />
  );
}
