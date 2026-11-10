// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The way out of a table open full screen (breatic#1427 §5.1): one button at
 * the top right of the window, named on hover.
 */

import * as React from 'react';
import { Minimize2 } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { setTableFullscreen } from '@web/spaces/document/document-table-fullscreen';
import type { HandleEditor } from '@web/spaces/document/document-handle-commands';

interface DocumentTableFullscreenExitProps {
  /** The editor whose table is open full screen. */
  readonly editor: HandleEditor;
}

/**
 * The exit button over a full-screen table.
 * @param props - The editor.
 * @param props.editor - The editor whose table is open full screen.
 * @returns The button.
 */
export const DocumentTableFullscreenExit = React.memo(function DocumentTableFullscreenExit({
  editor,
}: DocumentTableFullscreenExitProps): React.JSX.Element {
  const t = useTranslation();
  const label = t('spaces.document.table.exitFullscreen');
  // Back to the body with the caret where it was, so typing goes on there.
  const exit = React.useCallback(() => {
    setTableFullscreen(editor, null);
    editor.focus();
  }, [editor]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant='ghost'
          size='icon'
          aria-label={label}
          data-testid='doc-table-fullscreen-exit'
          className='absolute right-4 top-4 z-30'
          onClick={exit}
        >
          <Minimize2 className='h-4 w-4' />
        </Button>
      </TooltipTrigger>
      <TooltipContent side='bottom' align='end'>{label}</TooltipContent>
    </Tooltip>
  );
});
