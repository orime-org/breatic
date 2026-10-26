// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
import { Textarea } from '@web/components/ui/textarea';
import { useTranslation } from '@web/i18n/use-translation';
import { useDocumentBodyRuntime } from '@web/spaces/document/use-document-body-runtime';

/**
 * Reads retained text without calling a failed editor or its serializers.
 * @param snapshot - An accepted PM document or the retained legal projection.
 * @returns Plain text for local comparison, without rich-text export claims.
 * @throws {never}
 */
function retainedText(snapshot: unknown): string {
  const node = snapshot instanceof PMNode ? snapshot
    : typeof snapshot === 'object' && snapshot !== null && 'doc' in snapshot && snapshot.doc instanceof PMNode ? snapshot.doc : null;
  return node?.textBetween(0, node.content.size, '\n', '\ufffc') ?? '';
}

/**
 * Shows the mounted handle's pause and retained comparison material.
 * @param props - The same editor that owns all displayed local inputs.
 * @returns Nothing while active, or the persistent recovery notice.
 * @throws {never}
 */
export const DocumentBodyRuntimeNotice = React.memo(function DocumentBodyRuntimeNotice({ editor }: {
  editor: { readonly prosemirrorState: EditorState };
}): React.JSX.Element | null {
  const snapshot = useDocumentBodyRuntime(editor);
  const t = useTranslation();
  const acceptedId = React.useId();
  const lastGoodId = React.useId();
  if (snapshot === null || snapshot.status === 'active') return null;
  return (
    <div data-testid='document-body-runtime-notice'
      className='flex shrink-0 flex-col gap-2 rounded-overlay border border-status-warning-border bg-status-warning-bg p-3 text-sm text-status-warning-foreground'>
      <p>{t(snapshot.status === 'waiting' ? 'spaces.document.runtime.waiting' : 'spaces.document.runtime.failed')}</p>
      {snapshot.failure === null ? null : (
        <>
          <Label htmlFor={acceptedId}>{t('spaces.document.runtime.accepted')}</Label>
          <Textarea id={acceptedId} data-testid='document-body-retained-input' readOnly rows={3}
            className='resize-none [scrollbar-width:none]' value={retainedText(snapshot.failure.accepted)} />
          <Label htmlFor={lastGoodId}>{t('spaces.document.runtime.lastGood')}</Label>
          <Textarea id={lastGoodId} data-testid='document-body-last-good' readOnly rows={3}
            className='resize-none [scrollbar-width:none]' value={retainedText(snapshot.failure.lastGood)} />
          <Button variant='outline' size='sm' onClick={() => window.location.reload()}>
            {t('connection.banner.reload')}
          </Button>
        </>
      )}
    </div>
  );
});
