/**
 * Yjs document naming helpers for the Collab service.
 *
 * The canonical definitions live in `@breatic/shared`
 * (`yjs-doc-names.ts`) so Worker and Web import them from the same
 * place. This module re-exports them under the original names so
 * existing Collab-internal imports don't churn.
 */

export {
  canvasDocName,
  nodeEditorDocName,
  parseDocName,
} from "@breatic/shared";

export type { ParsedDocName } from "@breatic/shared";
