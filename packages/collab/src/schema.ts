/**
 * Yjs document naming helpers for the Collab service.
 *
 * The canonical definitions live in `@breatic/shared`
 * (`yjs-doc-names.ts`). Re-exported here so Collab-internal modules
 * can import from a stable local path (`./schema.js`) without each
 * touching the shared package directly.
 */

export { projectDocName, parseProjectDocName } from "@breatic/shared";
