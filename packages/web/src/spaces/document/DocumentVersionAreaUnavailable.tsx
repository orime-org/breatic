// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { COMMENT_PANEL_WIDTH } from '@web/spaces/document/document-columns';
import type { DocumentVersions } from '@web/spaces/document/use-document-versions';

const PANEL_WIDTH: React.CSSProperties = { width: COMMENT_PANEL_WIDTH };

/**
 * The snapshot panel's place when its chunk could not be fetched (a tab left
 * open across a deploy, a dropped connection): it says so, and closing it
 * brings the body back, as `CameraAngleControl` does for its sphere.
 * @param props - The panel's switch.
 * @param props.versions - It.
 * @returns The empty column and the panel saying the snapshots did not load.
 */
export function DocumentVersionAreaUnavailable({ versions }: { versions: DocumentVersions }): React.JSX.Element {
  const t = useTranslation();
  return (
    <>
      <div className='min-w-0 flex-1' />
      <aside data-testid='doc-version-unavailable' className='flex flex-none flex-col border-l border-border' style={PANEL_WIDTH}>
        <div className='sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background px-3 py-2'>
          <span className='min-w-0 truncate text-sm font-medium'>{t('spaces.document.versions.title')}</span>
          <Button
            variant='chrome-ghost'
            size='icon'
            className='ml-auto size-5.5 shrink-0'
            aria-label={t('spaces.document.versions.close')}
            data-testid='doc-version-close'
            onClick={versions.closePanel}
          >
            <X className='h-3.5 w-3.5' />
          </Button>
        </div>
        <p className='px-5 py-3 text-sm text-muted-foreground'>{t('spaces.document.versions.unavailable')}</p>
      </aside>
    </>
  );
}
