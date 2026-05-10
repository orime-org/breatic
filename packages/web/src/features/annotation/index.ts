/**
 * `features/annotation` — sticky-note style 批注 nodes (spec/02
 * §4.3 v13, F6).
 *
 * Public surface:
 *   - `AnnotationNode` — the registered ReactFlow node component
 *     (must be wired into `nodeTypes` under the `annotation` key).
 *   - `AnnotationComposer` — overlay rendered while one annotation
 *     is being composed (one at a time per LocalPending lock).
 *   - `useAnnotationActions` — drop / submit / cancel the in-flight
 *     annotation.
 *   - `ANNOTATION_NODE_TYPE` — string id for the node type, kept in
 *     sync with the `nodeTypes` registration.
 *
 * Storage model:
 *   - Pre-submit: LocalPending entry (per-user React state).
 *   - Post-submit: Yjs node with `data.content = text`,
 *     standard audit fields, `data.state = 'idle'` always (no
 *     backend lifecycle).
 */
export { default as AnnotationNode } from './AnnotationNode';
export { default as AnnotationComposer } from './AnnotationComposer';
export {
  useAnnotationActions,
  ANNOTATION_NODE_TYPE,
} from './use-annotation-actions';
