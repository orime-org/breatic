// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The face a link shows while an address is being typed: a field, a confirm,
 * and the reason underneath when the address is refused.
 *
 * Two controls raise it — the panel, for a new link and for changing one, and
 * the toolbar's own edit — and both want the same field, so the field lives
 * here and each of them says where the address gets written.
 */

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import {
  LINK_CONTROL_HEIGHT,
  LINK_TEXT_LEADING,
} from '@web/spaces/document/document-link-metrics';

/**
 * The address field, the confirm beside it, and the refusal under both.
 * @param props - The draft, whether it is refused, and what confirming does.
 * @param props.draft - What the reader has typed so far.
 * @param props.showInvalid - True once an address has been refused.
 * @param props.canSubmit - Whether the draft is shaped like an address.
 * @param props.onDraftChange - Run on every keystroke, with the new draft.
 * @param props.onSubmit - Run on confirm and on Enter.
 * @param props.inputRef - Handed the field, for callers that focus it.
 * @returns The column.
 */
export function DocumentLinkForm({
  draft,
  showInvalid,
  canSubmit,
  onDraftChange,
  onSubmit,
  inputRef,
}: {
  draft: string;
  showInvalid: boolean;
  canSubmit: boolean;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
}): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex items-center gap-1.5'>
        <Input
          data-testid='doc-link-input'
          ref={inputRef}
          value={draft}
          aria-invalid={showInvalid}
          placeholder={t('spaces.document.link.placeholder')}
          onChange={(event) => {
            onDraftChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
            }
          }}
          className={`${LINK_CONTROL_HEIGHT} w-[250px] bg-background px-2 py-0 text-sm`}
        />
        {/* `aria-disabled`, so the press still arrives: the reason an address
            is refused is a thing this face has to say, and a button carrying
            the HTML attribute is handed no click to say it on — nor any focus,
            which is what would have let the input's blur say it instead.
            Pressing it runs the submit, which turns the field red and puts the
            reason underneath. */}
        <Button
          variant='outline'
          size={null}
          aria-disabled={!canSubmit}
          onClick={onSubmit}
          data-testid='doc-link-confirm'
          className={`${LINK_CONTROL_HEIGHT} bg-transparent px-2.5 text-sm aria-disabled:opacity-50`}
        >
          {t('spaces.document.link.confirm')}
        </Button>
      </div>
      {showInvalid ? (
        <p
          data-testid='doc-link-invalid'
          className={`px-0.5 text-xs ${LINK_TEXT_LEADING} text-status-error-foreground`}
        >
          {t('spaces.document.link.invalid')}
        </p>
      ) : null}
    </div>
  );
}
