// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Whether the snapshot panel is open, and saving a snapshot (inner#1129
 * design §7.1, §7.5). `openPanel` and `closePanel` are the only writers of
 * `panelOpen`; what the panel shows is the versioning controller's.
 */

import * as React from 'react';
import { DOCUMENT_SCHEMA_VERSION } from '@breatic/shared';

import { documentsApi, type DocumentScope } from '@web/data/api/documents';
import { serverMessage } from '@web/data/api/server-message';
import { ApiException } from '@web/data/api/types';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { snapshotOf } from '@web/spaces/document/document-version-restore';

/** What the body reads when saving. */
interface Saveable {
  readonly prosemirrorState: { readonly doc: Parameters<typeof snapshotOf>[0] };
  readonly prosemirrorView: { readonly dom: HTMLElement } | undefined;
}

/** The snapshot panel's switch and the save flow. */
export interface DocumentVersions {
  readonly panelOpen: boolean;
  /** A restore is being written; the panel cannot close and other surfaces wait. */
  readonly restoring: boolean;
  /** Counts saves, so an open panel refreshes its list. */
  readonly saved: number;
  /** Whether the name dialog for a new snapshot is open. */
  readonly naming: boolean;
  readonly saving: boolean;
  readonly openPanel: () => void;
  readonly closePanel: () => void;
  readonly setRestoring: (restoring: boolean) => void;
  readonly requestSave: () => void;
  readonly cancelSave: () => void;
  readonly save: (name: string) => Promise<void>;
}

/**
 * The snapshot panel's state and saving, for one document.
 * @param editor - The body's editor.
 * @param scope - The document, or null where there is none to save to.
 * @returns The state and its actions.
 */
export function useDocumentVersions(editor: Saveable, scope: DocumentScope | null): DocumentVersions {
  const t = useTranslation();
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const [saved, setSaved] = React.useState(0);
  const [naming, setNaming] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const openPanel = React.useCallback(() => {
    // The body steps aside unseen; what it was playing stops with it.
    editor.prosemirrorView?.dom.querySelectorAll('video, audio').forEach((media) => {
      (media as HTMLMediaElement).pause();
    });
    setPanelOpen(true);
  }, [editor]);
  const closePanel = React.useCallback(() => setPanelOpen(false), []);
  const requestSave = React.useCallback(() => setNaming(true), []);
  const cancelSave = React.useCallback(() => setNaming(false), []);

  const save = React.useCallback(async (name: string): Promise<void> => {
    if (scope === null) return;
    const { content, leftOut } = snapshotOf(editor.prosemirrorState.doc);
    setSaving(true);
    try {
      await documentsApi.save(scope, { name: name === '' ? undefined : name, content, schemaVersion: DOCUMENT_SCHEMA_VERSION });
      setNaming(false);
      setSaved((n) => n + 1);
      toast.success(t('spaces.document.versions.saved'));
      if (leftOut > 0) toast.warning(t('spaces.document.versions.leftOut', { count: leftOut }));
    } catch (err) {
      if (err instanceof ApiException && err.reason === 'document_versions_full') {
        // The server's sentence carries the ceiling, which lives only in its config.
        setNaming(false);
        toast.warning(serverMessage(err, t('spaces.document.versions.saveFailed')));
      } else {
        toast.error(t('spaces.document.versions.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  }, [editor, scope, t]);

  return React.useMemo(
    () => ({ panelOpen, restoring, saved, naming, saving, openPanel, closePanel, setRestoring, requestSave, cancelSave, save }),
    [panelOpen, restoring, saved, naming, saving, openPanel, closePanel, requestSave, cancelSave, save],
  );
}
