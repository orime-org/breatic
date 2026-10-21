// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { FieldError } from '@web/components/FieldError';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { PROJECT_NAME_MAX_CHARS } from '@breatic/shared';
import { useTranslation } from '@web/i18n/use-translation';


interface RenameProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The name the field starts from. */
  currentName: string;
  /**
   * Called with the trimmed new name; `onSuccess` runs once the rename is in
   * and the lists showing the name have refreshed.
   */
  onRename: (name: string, options: { onSuccess: () => void }) => void;
  /** True while the rename request is in flight. */
  pending: boolean;
}

/**
 * The card menu's rename dialog: one name field, Save and Cancel. Save stays
 * off while the field is blank or unchanged. The dialog waits for the rename
 * and closes once the rename is in and the lists showing the name have
 * refreshed; a failure toasts and leaves the dialog open.
 * @param props - Open state, the current name and the rename callback.
 * @param props.open - Whether the dialog is shown.
 * @param props.onOpenChange - Called when the dialog asks to open or close.
 * @param props.currentName - The name the field starts from.
 * @param props.onRename - Called with the trimmed new name.
 * @param props.pending - Whether the rename request is in flight.
 * @returns The dialog.
 */
export function RenameProjectDialog({
  open,
  onOpenChange,
  currentName,
  onRename,
  pending,
}: RenameProjectDialogProps): React.JSX.Element {
  const t = useTranslation();
  const [name, setName] = React.useState(currentName);
  const [nameError, setNameError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Every opening starts from the name as it is now, not from what was typed
  // and abandoned last time.
  React.useEffect(() => {
    if (open) {
      setName(currentName);
      setNameError(null);
    }
  }, [open, currentName]);

  const next = name.trim();
  const required = t('studio.container.dialog.nameRequired');

  const submit = React.useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (pending) return;
      if (next.length === 0) {
        setNameError(required);
        inputRef.current?.focus();
        return;
      }
      // Nothing changed: saving is already done.
      if (next === currentName) {
        onOpenChange(false);
        return;
      }
      onRename(next, { onSuccess: () => onOpenChange(false) });
    },
    [currentName, next, onOpenChange, onRename, pending, required],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid='rename-project-dialog' aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('studio.container.card.renameTitle')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} noValidate>
          <DialogBody className='flex flex-col gap-1.5'>
            <Label htmlFor='rename-project-name'>{t('studio.container.card.renameLabel')}</Label>
            <Input
              id='rename-project-name'
              autoComplete='off'
              value={name}
              maxLength={PROJECT_NAME_MAX_CHARS}
              ref={inputRef}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
              aria-invalid={nameError !== null}
              aria-describedby={nameError !== null ? 'rename-project-name-error' : undefined}
            />
            {nameError !== null ? (
              <FieldError id='rename-project-name-error'>{nameError}</FieldError>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              {t('studio.container.card.cancel')}
            </Button>
            <Button type='submit' loading={pending}>
              {t('studio.container.card.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
