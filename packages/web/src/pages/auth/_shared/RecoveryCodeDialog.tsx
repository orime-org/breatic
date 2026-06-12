// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Copy, Download } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * One-time recovery-code reveal modal — shown after registration AND
 * after a successful recovery-code-based reset (because the server
 * rotates the code on every use, the new one must be re-saved with
 * the same urgency).
 *
 * Three UX guarantees the user cannot accidentally skip:
 *   1. The dialog is non-dismissible — no overlay-click / Escape close,
 *      and no X button in the header (`hideClose`). The only exit is
 *      via the acknowledged "Continue" action.
 *   2. The acknowledge checkbox blocks the primary action ("Continue")
 *      until ticked, with copy + download buttons surfaced first.
 *   3. The code is rendered in a monospace block with a `select-all`
 *      cursor so accidental partial selection doesn't truncate.
 *
 * This is the only chance the user has to capture the recovery code
 * — the server only stores its bcrypt hash, so a missed save is
 * unrecoverable until they re-register or remember their password.
 */
interface RecoveryCodeDialogProps {
  open: boolean;
  /**
   * Plaintext recovery code in `XXXX-XXXX-XXXX-XXXX` format from the
   * server. Caller is responsible for clearing it from React state
   * after `onContinue` (we never persist it client-side).
   */
  code: string;
  onContinue: () => void;
}

/**
 * Non-dismissible dialog revealing the recovery code with copy / download and
 * an acknowledge gate.
 * @param root0 - component props
 * @param root0.open - whether the dialog is shown
 * @param root0.code - the plaintext recovery code to reveal
 * @param root0.onContinue - called once the user acknowledges and clicks Continue
 * @returns a non-dismissible dialog revealing the recovery code with copy/download and an acknowledge gate.
 */
export function RecoveryCodeDialog({
  open,
  code,
  onContinue,
}: RecoveryCodeDialogProps): React.JSX.Element {
  const t = useTranslation();
  const [acknowledged, setAcknowledged] = React.useState(false);

  // Reset the ack when a fresh code comes in (post-reset reveal etc.).
  React.useEffect(() => {
    if (open) setAcknowledged(false);
  }, [open, code]);

  /**
   * Copy the recovery code to the clipboard and toast the outcome.
   */
  async function copyToClipboard(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(t('auth.recovery.copied'), { id: 'auth-recovery' });
    } catch {
      toast.error(t('auth.recovery.copyFailed'), { id: 'auth-recovery' });
    }
  }

  /**
   * Download the recovery code as a plain-text `.txt` file via a transient
   * object-URL anchor.
   */
  function downloadAsFile(): void {
    const blob = new Blob([code + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'breatic-recovery-code.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog open={open}>
      <DialogContent
        // Block the standard close affordances: clicking outside or
        // pressing Escape must NOT close the dialog. The only exit is
        // through the acknowledged "Continue" action.
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader hideClose>
          <DialogTitle>{t('auth.recovery.title')}</DialogTitle>
          <DialogDescription>{t('auth.recovery.subtitle')}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className='rounded-md border border-border bg-muted p-4 text-center font-mono text-lg tracking-wider select-all'>
            {code}
          </div>

          <div className='flex gap-2'>
            <Button
              type='button'
              variant='outline'
              className='flex-1'
              onClick={copyToClipboard}
            >
              <Copy className='mr-2 h-4 w-4' aria-hidden />
              {t('auth.recovery.copy')}
            </Button>
            <Button
              type='button'
              variant='outline'
              className='flex-1'
              onClick={downloadAsFile}
            >
              <Download className='mr-2 h-4 w-4' aria-hidden />
              {t('auth.recovery.download')}
            </Button>
          </div>

          <div className='flex items-start gap-2'>
            <input
              id='ack-recovery-saved'
              type='checkbox'
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className='mt-0.5 h-4 w-4 rounded border-border accent-foreground'
            />
            <Label
              htmlFor='ack-recovery-saved'
              className='cursor-pointer text-sm leading-snug font-normal'
            >
              {t('auth.recovery.ack')}
            </Label>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            type='button'
            disabled={!acknowledged}
            onClick={onContinue}
            className='w-full'
          >
            {t('auth.recovery.continue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
