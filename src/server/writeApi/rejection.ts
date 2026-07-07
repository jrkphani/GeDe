// Typed rejection shapes for the write-path API — mirrors issue 015's calm-
// error style ("a server-rejected mutation surfaces as a calm client error
// (015 style)", issue 043 scope). This is the wire contract issue 032's
// client mutation queue reconciles against: one reason code (stable,
// machine-checkable) plus one human message (safe to render verbatim in the
// status bar, per src/store/status.ts's single feedback channel).
export type WriteRejectionReason =
  | 'missing_token'
  | 'invalid_token'
  | 'expired_token'
  | 'missing_claims'
  | 'malformed_mutation'
  | 'cross_tenant'
  | 'unknown_entity'
  | 'dimension_floor'
  | 'binding_uniqueness'
  | 'referential_integrity'
  | 'stale_conflict'

export interface WriteRejection {
  readonly mutationId: string
  readonly reason: WriteRejectionReason
  readonly message: string
}

export function rejection(mutationId: string, reason: WriteRejectionReason, message: string): WriteRejection {
  return { mutationId, reason, message }
}
