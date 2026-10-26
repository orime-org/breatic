// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { ErrorBoundary } from '@sentry/react';
import { Unlock } from 'lucide-react';
import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { useCurrentUserStore } from '@web/stores/current-user';
import { docName, getDoc } from '@web/data/yjs/manager';
import { readSceneDocument } from '@web/data/yjs/scene-document';
import { getSceneSession } from '@web/data/yjs/scene-session';
import type { SceneSession } from '@web/data/yjs/scene-session';
import { useSpaceConnection } from '@web/data/yjs/space-connection';
import { regionOwnsKeyboard } from '@web/features/active-region/keyboard-scope';
import { useNamed } from '@web/features/collab-editor/collaborator-names-context';
import { isEditableTarget } from '@web/lib/is-editable-target';
import { toast } from '@web/lib/toast';
import SceneEditor from '@web/spaces/three-d/SceneEditor';
import type { SceneObject } from '@breatic/shared';
import type { SpaceBodyProps } from '@web/spaces';

/**
 * Resolve keyboard ownership in the Space host.
 * @param target - Event target receiving a scene shortcut.
 * @returns Whether the Space owns this non-editable keyboard target.
 */
function ownsSceneKeyboard(target: EventTarget | null): boolean {
  return regionOwnsKeyboard(target, 'space') && !isEditableTarget(target instanceof Element ? target : null);
}

/**
 * Bind existing Project services to the scene editor.
 * @param props - Space identity and the resolved signed-in account.
 * @returns The editor with its current document projection and connection.
 */
function ConnectedSceneEditor(props: SpaceBodyProps & { userId: string }): React.JSX.Element {
  const { projectId, spaceId } = props;
  const name = docName.threeDSpace(projectId, spaceId);
  const doc = React.useMemo(() => getDoc(name), [name]);
  const [session, setSession] = React.useState<SceneSession | null>(null);
  const t = useTranslation();
  // Session construction observes document changes. Resolve the cached
  // document owner after commit, never while another subscriber renders.
  React.useEffect(() => {
    setSession(getSceneSession(doc, name));
  }, [doc, name]);
  if (session?.doc !== doc) return <div className='grid h-full place-items-center text-sm text-muted-foreground'>{t('spaces.threeD.loading')}</div>;
  return <BoundSceneEditor {...props} session={session} />;
}

/**
 * Subscribe only after the document-owned session has been resolved outside rendering.
 * @param props - Space identity and its live cached session.
 * @returns The editor with the current session projection.
 */
function BoundSceneEditor(props: SpaceBodyProps & { userId: string; session: SceneSession }): React.JSX.Element {
  const { session, ...space } = props;
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  const connection = useSpaceConnection();
  const namedPeers = useNamed(snapshot.remotePeers);
  const t = useTranslation();
  const refusalTold = React.useRef(false);
  React.useEffect(() => {
    const refusedWithContent = connection.status === 'authFailed' && connection.hasEverSynced;
    if (refusedWithContent && !refusalTold.current) toast.error(t('spaces.threeD.refused'));
    refusalTold.current = refusedWithContent;
  }, [connection.status, connection.hasEverSynced, t]);
  /**
   * Read committed values when an inspector edit is submitted.
   * @returns Current valid committed scene objects.
   */
  const readObjects = React.useCallback((): readonly SceneObject[] => readSceneDocument(session.doc).objects, [session]);
  return <SceneEditor {...space} session={session} snapshot={snapshot} connection={connection}
    namedPeers={namedPeers} readObjects={readObjects} ownsKeyboard={ownsSceneKeyboard} UnlockIcon={Unlock} />;
}

/**
 * Render scene controls in the Project while the viewport remains lazy.
 * @param props - Space properties supplied by the Project host.
 * @returns Document-bound editor or its loading and error feedback.
 */
export function ThreeDSpace(props: SpaceBodyProps): React.JSX.Element {
  const t = useTranslation();
  const userId = useCurrentUserStore((state) => state.user?.id);
  const loading = <div className='grid h-full place-items-center text-sm text-muted-foreground'>{t('spaces.threeD.loading')}</div>;
  if (!userId) return loading;
  return (
    <ErrorBoundary key={`${userId}:${props.projectId}:${props.spaceId}`} fallback={<div className='grid h-full place-items-center p-4'><div className='flex flex-col items-center gap-3'>
      <p>{t('spaces.threeD.loadFailed')}</p><Button onClick={() => window.location.reload()}>{t('spaces.threeD.reload')}</Button>
    </div></div>}>
      <React.Suspense fallback={loading}>
        <ConnectedSceneEditor {...props} userId={userId} />
      </React.Suspense>
    </ErrorBoundary>
  );
}
