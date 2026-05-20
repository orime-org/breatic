import * as React from 'react';
import * as Y from 'yjs';

import type { SpaceType } from '@/spaces';
import { docName, getDoc } from '@/data/yjs/manager';
import { useSocket } from '@/data/yjs/use-socket';

/**
 * Project meta Yjs document — single source of truth for the project's
 * spaces list + project-level settings.
 *
 * Y.Doc structure:
 *   - Y.Array("spaces") of Y.Map<{ id, name, type, locked? }>
 *
 * The frontend owns `create / delete / reorder` of spaces; the backend
 * only ever reads the resulting document.
 */

export interface ProjectSpace {
  id: string;
  name: string;
  type: SpaceType;
  locked?: boolean;
}

interface ProjectMetaState {
  spaces: ReadonlyArray<ProjectSpace>;
  synced: boolean;
}

const SPACES_KEY = 'spaces';

/**
 * Subscribe to a project's meta document. Returns the live spaces list
 * + initial sync flag; updates trigger re-renders.
 */
export function useProjectMeta(projectId: string): ProjectMetaState {
  const doc = React.useMemo(
    () => getDoc(docName.projectMeta(projectId)),
    [projectId],
  );
  const { synced } = useSocket({ name: docName.projectMeta(projectId), doc });
  const [spaces, setSpaces] = React.useState<ReadonlyArray<ProjectSpace>>(() =>
    readSpaces(doc),
  );

  React.useEffect(() => {
    const update = () => setSpaces(readSpaces(doc));
    const spacesArr = doc.getArray<Y.Map<unknown>>(SPACES_KEY);
    spacesArr.observeDeep(update);
    update();
    return () => spacesArr.unobserveDeep(update);
  }, [doc]);

  return { spaces, synced };
}

/**
 * Append a new space at the end of the spaces array. Yjs ensures the
 * write replicates to all collaborators connected to the same project.
 */
export function appendSpace(projectId: string, space: ProjectSpace): void {
  const doc = getDoc(docName.projectMeta(projectId));
  const spacesArr = doc.getArray<Y.Map<unknown>>(SPACES_KEY);
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set('id', space.id);
    map.set('name', space.name);
    map.set('type', space.type);
    if (space.locked) map.set('locked', true);
    spacesArr.push([map]);
  });
}

/**
 * Remove the space with the given id. No-op if id is unknown.
 */
export function removeSpace(projectId: string, spaceId: string): void {
  const doc = getDoc(docName.projectMeta(projectId));
  const spacesArr = doc.getArray<Y.Map<unknown>>(SPACES_KEY);
  doc.transact(() => {
    for (let i = spacesArr.length - 1; i >= 0; i--) {
      if (spacesArr.get(i).get('id') === spaceId) {
        spacesArr.delete(i, 1);
      }
    }
  });
}

function readSpaces(doc: Y.Doc): ReadonlyArray<ProjectSpace> {
  const spacesArr = doc.getArray<Y.Map<unknown>>(SPACES_KEY);
  const out: ProjectSpace[] = [];
  for (let i = 0; i < spacesArr.length; i++) {
    const m = spacesArr.get(i);
    out.push({
      id: String(m.get('id') ?? ''),
      name: String(m.get('name') ?? ''),
      type: (m.get('type') as SpaceType) ?? 'canvas',
      locked: Boolean(m.get('locked') ?? false),
    });
  }
  return out;
}
