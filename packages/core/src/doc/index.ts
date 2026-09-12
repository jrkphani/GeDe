/**
 * The document layer: Yjs schema, readers, mutations, geometry, presence, undo.
 * Consumers hold a `GedeDoc` (from `openDocument`) and pass it to every call.
 */
export * from './schema.js';
export * from './geometry.js';
export * from './mutations.js';
export * from './presence.js';
export * from './undo.js';
export * from './seed.js';
