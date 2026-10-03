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
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';

/** The server's ceiling on a project name (`PATCH /projects/:id`). */
const NAME_MAX = 255;

interface RenameProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The name the field starts from. */
  currentName: string;
  /** Called with the trimmed new name; the dialog closes right after. */
  onRename: (name: string) => void;
}

/**
 * The card menu's rename dialog: one name field, Save and Cancel. Save stays
 * off while the field is blank or unchanged. The dialog closes on save; the
 * rename itself shows its result optimistically and toasts if it fails.
 * @param props - Open state, the current name and the rename callback.
 * @param props.open - Whether the dialog is shown.
 * @param props.onOpenChange - Called when the dialog asks to open or close.
 * @param props.currentName - The name the field starts from.
 * @param props.onRename - Called with the trimmed new name.
 * @returns The dialog.
 */
export function RenameProjectDialog({
  open,
  onOpenChange,
  currentName,
  onRename,
}: RenameProjectDialogProps): React.JSX.Element {
  const t = useTranslation();
  const [name, setName] = React.useState(currentName);
  // Every opening starts from the name as it is now, not from what was typed
  // and abandoned last time.
  React.useEffect(() => {
    if (open) setName(currentName);
  }, [open, currentName]);

  const next = name.trim();
  const canSave = next.length > 0 && next !== currentName;

  const submit = React.useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (!canSave) return;
      onRename(next);
      onOpenChange(false);
    },
    [canSave, next, onOpenChange, onRename],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid='rename-project-dialog' aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('studio.container.card.renameTitle')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit}>
          <DialogBody className='flex flex-col gap-1.5'>
            <Label htmlFor='rename-project-name'>{t('studio.container.card.renameLabel')}</Label>
            <Input
              id='rename-project-name'
              autoComplete='off'
              value={name}
              maxLength={NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </DialogBody>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              {t('studio.container.card.cancel')}
            </Button>
            <Button type='submit' disabled={!canSave}>
              {t('studio.container.card.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
