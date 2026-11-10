// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { DOCUMENT_VERSION_NAME_MAX_CHARS } from '@breatic/shared';

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
import { useTranslation } from '@web/i18n/use-translation';

interface DocumentSnapshotNameDialogProps {
  /** Saving a new snapshot, renaming one, or closed. */
  mode: 'save' | 'rename' | null;
  /** The name the field starts from. */
  currentName: string;
  /** True while the request is in flight. */
  pending: boolean;
  /** Asks to close; ignored while pending. */
  onClose: () => void;
  /** Called with the trimmed name, empty for none. */
  onSubmit: (name: string) => void;
}

/**
 * The dialog that names a snapshot, when saving or renaming one (inner#1129
 * design §7.5, §7.6). A name is optional: an empty one shows the time the
 * snapshot was saved. An unchanged name closes it with nothing sent, as the
 * project rename dialog does.
 * @param props - Dialog props.
 * @param props.mode - What it is for, or null when closed.
 * @param props.currentName - The name the field starts from.
 * @param props.pending - Whether the request is in flight.
 * @param props.onClose - Closes it.
 * @param props.onSubmit - Sends the name.
 * @returns The dialog.
 */
export function DocumentSnapshotNameDialog({
  mode,
  currentName,
  pending,
  onClose,
  onSubmit,
}: DocumentSnapshotNameDialogProps): React.JSX.Element {
  const t = useTranslation();
  const [name, setName] = React.useState(currentName);
  // Every opening starts from the name as it is now.
  React.useEffect(() => {
    if (mode !== null) setName(currentName);
  }, [mode, currentName]);

  /**
   * Sends the name, or closes when a rename changed nothing.
   * @param event - The form's submit.
   */
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const next = name.trim();
    if (mode === 'rename' && next === currentName.trim()) {
      onClose();
      return;
    }
    onSubmit(next);
  };

  return (
    <Dialog open={mode !== null} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent data-testid='doc-snapshot-name-dialog' aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {mode === 'rename' ? t('spaces.document.versions.renameTitle') : t('spaces.document.docMenu.saveSnapshot')}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} noValidate>
          <DialogBody>
            <Input
              data-testid='doc-snapshot-name-input'
              autoComplete='off'
              value={name}
              maxLength={DOCUMENT_VERSION_NAME_MAX_CHARS}
              placeholder={t('spaces.document.versions.namePlaceholder')}
              readOnly={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </DialogBody>
          <DialogFooter>
            <Button type='button' variant='outline' disabled={pending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type='submit' loading={pending} data-testid='doc-snapshot-name-submit'>
              {mode === 'rename' ? t('spaces.document.versions.rename') : t('spaces.document.versions.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
