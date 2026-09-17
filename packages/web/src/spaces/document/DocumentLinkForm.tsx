// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The face a link shows while an address is being typed: a field, a confirm,
 * and the reason underneath when the address is refused.
 *
 * Two controls raise it — the panel, for a new link and for changing one, and
 * the toolbar's own edit — and both want the same field, so the field lives
 * here and each of them says where the address gets written.
 *
 * What is typed, whether it is refused, and what an unqualified address
 * becomes are all this face's own business. Held by each control instead, one
 * question — is this shaped like an address — was asked in three places for
 * one press, and every control that ever raises the field has to carry a
 * draft, a refusal, and the handful of resets that keep them in step.
 */

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import {
  isLinkUrlShaped,
  normalizeLinkUrl,
} from '@web/spaces/document/document-link';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';

/**
 * The address field, the confirm beside it, and the refusal under both.
 * @param props - What to start from and where to write.
 * @param props.initial - The address to start the field with, read once as it
 *   mounts. Each control raises the field by mounting it, so there is nothing
 *   to carry over from the last time it was up.
 * @param props.onSubmit - Run with the address, stored form and all, once the
 *   field is satisfied with it. An address it refuses never reaches here.
 * @param props.inputRef - Handed the field. Each control takes the focus at
 *   its own moment: this one is a child of floating-ui's focus manager, which
 *   records where the focus was when it opens, so a field that took the focus
 *   on its own mount would be recorded as the place to hand it back to.
 * @returns The column.
 */
export function DocumentLinkForm({
  initial,
  onSubmit,
  inputRef,
}: {
  initial: string;
  onSubmit: (href: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}): React.JSX.Element {
  const t = useTranslation();
  const [draft, setDraft] = React.useState(initial);
  const [showInvalid, setShowInvalid] = React.useState(false);
  // Whether the draft is shaped like an address is the field's own question.
  const canSubmit = isLinkUrlShaped(draft);
  /** Hand the address over, or say why it is not one. */
  const submit = React.useCallback((): void => {
    if (!isLinkUrlShaped(draft)) {
      setShowInvalid(true);
      return;
    }
    onSubmit(normalizeLinkUrl(draft));
  }, [draft, onSubmit]);
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
            setDraft(event.target.value);
            // A refusal is about the address that earned it.
            setShowInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          className='h-[var(--btn-inline)] w-[250px] px-2 py-0 text-sm'
        />
        {/* `aria-disabled`, so the press still arrives: the reason an address
            is refused is a thing this face has to say, and a button carrying
            the HTML attribute is handed no click to say it on — nor any focus,
            which is what would have let the input's blur say it instead.
            Pressing it runs the submit, which turns the field red and puts the
            reason underneath. */}
        <Button
          variant='outline'
          size='sm'
          aria-disabled={!canSubmit}
          onClick={submit}
          data-testid='doc-link-confirm'
          className='bg-transparent aria-disabled:opacity-50'
        >
          {t('spaces.document.link.confirm')}
        </Button>
      </div>
      {showInvalid ? (
        <p
          data-testid='doc-link-invalid'
          className='px-0.5 text-xs leading-[1.6] text-status-error-foreground'
        >
          {t('spaces.document.link.invalid')}
        </p>
      ) : null}
    </div>
  );
}
