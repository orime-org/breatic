// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Copy, Download } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';

interface RecoveryCodePanelProps {
  /** Plaintext recovery code in `XXXX-XXXX-XXXX-XXXX` format from the server. */
  code: string;
  /** Called once the user acknowledges saving the code and clicks Continue. */
  onContinue: () => void;
}

/**
 * Recovery-code reveal body — the one-time code with copy / download actions
 * and an acknowledge gate. Rendered inside an `AuthCardShell` by
 * `RecoveryCodePage` (a dedicated auth-flow screen, not a modal). The
 * acknowledge checkbox blocks the Continue action until ticked; the code is
 * shown once and the server only stores its bcrypt hash, so a missed save is
 * unrecoverable.
 * @param root0 - component props
 * @param root0.code - the plaintext recovery code to reveal
 * @param root0.onContinue - called once the user acknowledges and clicks Continue
 * @returns the recovery-code reveal body with copy/download and an acknowledge gate.
 */
export function RecoveryCodePanel({
  code,
  onContinue,
}: RecoveryCodePanelProps): React.JSX.Element {
  const t = useTranslation();
  const [acknowledged, setAcknowledged] = React.useState(false);

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
    <div className='flex flex-col gap-3'>
      <div className='rounded-md border border-border bg-muted p-4 text-center font-mono text-lg tracking-wider select-all'>
        {code}
      </div>

      <div className='flex gap-2'>
        <Button
          type='button'
          size='form'
          variant='outline'
          className='flex-1'
          onClick={copyToClipboard}
        >
          <Copy className='mr-2 h-4 w-4' aria-hidden />
          {t('auth.recovery.copy')}
        </Button>
        <Button
          type='button'
          size='form'
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

      <Button
        type='button'
        size='form'
        disabled={!acknowledged}
        onClick={onContinue}
        className='mt-1 w-full'
      >
        {t('auth.recovery.continue')}
      </Button>
    </div>
  );
}
