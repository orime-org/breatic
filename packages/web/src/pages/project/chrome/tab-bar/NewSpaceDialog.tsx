// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { SPACE_NAME_MAX_LEN } from '@breatic/shared';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@web/components/ui/tooltip';
import { cn } from '@web/lib/utils';
import { useExclusiveOverlay } from '@web/lib/use-exclusive-overlay';
import { SpaceKindPicker } from '@web/spaces/SpaceKindPicker';
import { type SpaceType } from '@web/spaces';
import { useTranslation } from '@web/i18n/use-translation';

interface NewSpaceDialogProps {
  trigger: React.ReactNode;
  /**
   * Optional tooltip shown on hover/focus of the trigger button.
   * Wrapped *inside* `DialogTrigger` so Radix's `asChild` chain
   * (`TooltipTrigger asChild → DialogTrigger asChild → button`)
   * still forwards click + aria-* to the real button — the same
   * nesting pattern viewport-toolbar's zoom popover uses.
   */
  tooltip?: string;
  /**
   * Returns a promise when the create call is async (the parent
   * routes through `sendSpaceRpc({ type: 'space:create' })`). The
   * dialog disables the form while the promise is in flight and
   * shows the error message inline if the call rejects.
   */
  onCreate: (type: SpaceType, name: string) => Promise<void> | void;
}

/**
 * New-space dialog — picks a Space type via the shared `SpaceKindPicker`
 * 3-card segmented control (canvas / document / timeline), accepts a name,
 * then delegates the actual create call to the page (which sends
 * `space:create` RPC over the live meta-doc Hocuspocus connection + waits
 * for the broadcast back).
 *
 * The type picker is the shared `SpaceKindPicker` widget so this dialog and
 * the studio-page new-project dialog stay visually identical without
 * duplicating the card markup. Only canvas is selectable today (decision D,
 * 2026-05-21); the picker owns that rule.
 * @param root0 - Component props.
 * @param root0.trigger - Element that opens the dialog (wired through Radix `asChild`).
 * @param root0.tooltip - Optional tooltip shown on hover/focus of the trigger button.
 * @param root0.onCreate - Called with the chosen type and trimmed name to perform the (possibly async) create.
 * @returns The new-space dialog with its type segmented control, name input, and create/cancel actions.
 */
export function NewSpaceDialog({ trigger, tooltip, onCreate }: NewSpaceDialogProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = useExclusiveOverlay('new-space-dialog');
  const [type, setType] = React.useState<SpaceType>('canvas');
  const [name, setName] = React.useState('');
  // submitting state removed 2026-05-25: dialog now closes optimistically
  // on submit (fire-and-forget), so there is no in-dialog pending phase.
  // The full-screen LoadingOverlay (owned by ProjectPage) is the user-
  // facing pending affordance, and callRpc raises the failure toast.
  const [error, setError] = React.useState<string | null>(null);

  /**
   * Clears the name input, resets the type to canvas, and drops any error.
   */
  const reset = (): void => {
    setName('');
    setType('canvas');
    setError(null);
  };

  /**
   * Validates the name, optimistically closes the dialog, and fires the
   * `onCreate` call (errors surface via ProjectPage's toast).
   */
  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    // Optimistic close: dismiss the dialog immediately so the
    // ProjectPage full-screen LoadingOverlay is visible while the
    // RPC round-trips. Errors surface via toast from ProjectPage's
    // callRpc — no need to keep the dialog open for inline display.
    setError(null);
    // NOTE: do NOT call `reset()` here. Resetting `name` synchronously
    // would flip the submit button into the `disabled` state during
    // the dialog's close animation (300ms), and PR #137's primitive
    // `disabled:cursor-not-allowed` rule would surface a momentary
    // 🚫 stop-sign cursor as a visible flash on the create button.
    // Instead, the form clears once the dialog is fully closed (see
    // the `useEffect` watching `open` below).
    setOpen(false);
    void Promise.resolve(onCreate(type, trimmed)).catch(() => {
      // Swallow — ProjectPage already raised the user-facing toast
      // inside callRpc. We just don't want an unhandled rejection.
    });
  };

  // Defer the form reset until after the dialog close animation has
  // finished. This keeps the submit button enabled (and the cursor
  // unchanged) during the close transition — see the `submit` comment
  // above for the full rationale. 300ms matches Radix Dialog's stock
  // close-state duration.
  React.useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      reset();
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
    // `reset` is stable-by-convention (only flips local setters); not
    // listing it avoids re-arming the timer on every render.

  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Form reset lives in the `useEffect([open])` above so the
        // close animation can play out with the button still showing
        // its enabled cursor — same rationale as the submit path.
        setOpen(next);
      }}
    >
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>{trigger}</DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side='bottom'>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      )}
      <DialogContent data-testid='new-space-dialog'>
        <DialogHeader>
          <DialogTitle>{t('spaces.create.title')}</DialogTitle>
          <DialogDescription>{t('spaces.create.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <SpaceKindPicker
            value={type}
            onChange={setType}
            idPrefix='new-space-type'
          />
          <div className='flex flex-col gap-2'>
            <div className='flex items-baseline justify-between gap-3'>
              <Label htmlFor='new-space-name'>
                {t('spaces.create.nameLabel')}
              </Label>
              {/* Live remaining-character hint. Turns warning color in
                  the last ~10% of the cap so the user sees the wall
                  coming before the maxLength hard-stops them. */}
              <span
                className={cn(
                  'text-[11px] tabular-nums',
                  name.length >= SPACE_NAME_MAX_LEN - 8
                    ? 'text-status-warning-foreground'
                    : 'text-muted-foreground',
                )}
                data-testid='new-space-name-counter'
                aria-live='polite'
              >
                {t('spaces.create.nameRemaining', {
                  count: Math.max(0, SPACE_NAME_MAX_LEN - name.length),
                })}
              </span>
            </div>
            <Input
              id='new-space-name'
              value={name}
              maxLength={SPACE_NAME_MAX_LEN}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('spaces.create.namePlaceholder')}
              data-testid='new-space-name'
              // eslint-disable-next-line jsx-a11y/no-autofocus -- dialog first input; users open the dialog expecting to type a name immediately
              autoFocus
            />
          </div>
          {error ? (
            <div
              className='text-sm text-status-error-foreground'
              data-testid='new-space-error'
            >
              {error}
            </div>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => {
              reset();
              setOpen(false);
            }}
          >
            {t('spaces.create.cancel')}
          </Button>
          <Button
            onClick={submit}
            disabled={name.trim().length === 0}
            data-testid='new-space-submit'
          >
            {t('spaces.create.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
