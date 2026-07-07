// The identity seam issue 032 owns building (not filling): the sync
// connection must carry the Cognito JWT (ADR-0009), but 033 (Cognito auth)
// is a concurrent, independent slice — 032 must not hard-depend on it having
// landed. `TokenProvider` is the minimal interface 033 supplies a real
// implementation of; until then, `noAuth` is the default, an explicit,
// clearly-named no-op (not a silent undefined) so a future caller can grep
// for it and see exactly where the real provider needs to be swapped in.
export type TokenProvider = () => Promise<string | null>

export const noAuth: TokenProvider = () => Promise.resolve(null)
