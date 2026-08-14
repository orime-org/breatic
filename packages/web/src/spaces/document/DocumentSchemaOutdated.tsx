// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { RefreshCw } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { formatRelativeTime } from '@web/lib/format-relative-time';

interface DocumentSchemaOutdatedProps {
  /** When the server last published a changed vocabulary, if it said. */
  publishedAt: string | null;
}

/**
 * What fills a document Space when this build must not open it.
 *
 * The situation is outside what we promise: the person is running a version
 * that can no longer represent what this document holds, and there is nothing
 * to fix on our side or theirs except getting the newer code. So this does the
 * three things such a message owes them and stops there — says what happened,
 * says what refreshing costs, and leaves the refreshing to them.
 *
 * ## Only one risk, because only one is real
 *
 * Interrupted uploads are. The undo and redo history is not: by the time this
 * is on screen the editor has already been destroyed and the stack went with
 * it, so naming it as a cost of refreshing would send someone looking for
 * something that is already gone.
 *
 * ## One state, no branches
 *
 * It takes no argument that could select a variant, and that is deliberate.
 * Earlier drafts said different things depending on which condition fired, and
 * remembered whether the user had already refreshed once so it could soften the
 * advice the second time. That is the shape of in-promise work — deciding on
 * the user's behalf, and trying to be right in every case. Here, if a refresh
 * does not help, they will refresh again; what they need from us is the facts,
 * not our judgement of what those facts imply.
 *
 * `publishedAt` is not a variant: it is one sentence that appears when there is
 * a truthful one to say, and is absent otherwise. Nothing is invented to fill
 * the gap. It is the server vocabulary's own release date, so it says the same
 * true thing on whichever check tripped; the caller passes it through either
 * way and withholds it only when meta carries no date at all — see
 * `use-document-schema-intercept`.
 *
 * ## Why the whole body, rather than a layer over the editor
 *
 * A half-transparent layer answers the mouse and nothing else — the focus stays
 * in the contenteditable behind it and every keystroke still reaches the shared
 * document. There is no editor here at all: the container never builds one
 * while this is showing. Same shape as the `unavailable` branch beside it.
 * @param root0 - Panel props.
 * @param root0.publishedAt - Server publish time, or null when unknown.
 * @returns The panel that replaces the editor.
 */
export const DocumentSchemaOutdated = React.memo(function DocumentSchemaOutdated({
  publishedAt,
}: DocumentSchemaOutdatedProps): React.JSX.Element {
  const t = useTranslation();

  // Computed on every render rather than memoised, and that is the fix: `t`'s
  // identity never changes (the locale engine swaps its messages underneath and
  // re-renders subscribers), so a memo keyed on it would never recompute — the
  // relative time would stay in the language it was first rendered in while
  // every other line on the panel switched. The call is a date subtraction and
  // a lookup.
  const when =
    publishedAt !== null && !Number.isNaN(Date.parse(publishedAt))
      ? formatRelativeTime(publishedAt, t)
      : null;

  const reload = React.useCallback(() => {
    window.location.reload();
  }, []);

  return (
    <div
      role='alert'
      data-testid='document-schema-outdated'
      className='flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center'
    >
      <RefreshCw className='h-6 w-6 text-muted-foreground' aria-hidden />
      <p
        data-testid='document-schema-outdated-headline'
        className='text-base font-semibold text-foreground'
      >
        {t('spaces.document.schemaOutdated.headline')}
      </p>
      <p className='max-w-md text-sm text-muted-foreground'>
        {t('spaces.document.schemaOutdated.body')}
        {when !== null && (
          <span data-testid='document-schema-outdated-published' className='text-foreground'>
            {' '}
            {t('spaces.document.schemaOutdated.published', { when })}
          </span>
        )}
      </p>
      <p
        data-testid='document-schema-outdated-risks'
        className='max-w-md rounded-content-sm border border-status-warning-border bg-status-warning-bg px-3 py-2.5 text-left text-sm leading-relaxed text-foreground'
      >
        <span className='font-semibold'>
          {t('spaces.document.schemaOutdated.risksLead')}
        </span>{' '}
        {t('spaces.document.schemaOutdated.riskUploads')}
      </p>
      <Button
        variant={null}
        size={null}
        type='button'
        data-testid='document-schema-outdated-refresh'
        onClick={reload}
        className='inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium transition-colors duration-150 hover:bg-muted focus-visible:ring-1 focus-visible:ring-active-border focus-visible:outline-none'
      >
        <RefreshCw className='h-3.5 w-3.5' aria-hidden />
        {t('spaces.document.schemaOutdated.action')}
      </Button>
    </div>
  );
});
