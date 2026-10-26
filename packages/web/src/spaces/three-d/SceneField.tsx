// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * Preserve invalid numeric/name drafts until the user corrects or cancels them.
 * @param root0 - Scene identity and editing properties from the Space host.
 * @param root0.label - Visible caption associated with the input.
 * @param root0.value - Current numeric value to format or committed field text.
 * @param root0.disabled - Whether current editing eligibility disables this field.
 * @param root0.numeric - Whether the input requests decimal text entry.
 * @param root0.onCommit - Applies a submitted draft and reports whether it was accepted.
 * @returns A labelled input retaining unaccepted drafts.
 */
export function SceneField({ label, value, disabled, numeric = false, onCommit }: {
  label: string; value: string; disabled: boolean; numeric?: boolean; onCommit: (value: string) => boolean;
}): React.JSX.Element {
  const t = useTranslation();
  const id = React.useId();
  const [draft, setDraft] = React.useState(value);
  const [failed, setFailed] = React.useState(false);
  const focused = React.useRef(false);
  const cancelled = React.useRef(false);
  React.useEffect(() => {
    if (!focused.current && !failed) setDraft(value);
  }, [value, failed]);
  return <div className='min-w-0 space-y-1'>
    <Label htmlFor={id} className='text-xs text-muted-foreground'>{label}</Label>
    <Input id={id} autoComplete='off' inputMode={numeric ? 'decimal' : 'text'} value={draft} disabled={disabled}
      className='h-8 min-w-0 text-xs' aria-invalid={failed}
      onFocus={() => { focused.current = true; }}
      onChange={(event) => { setDraft(event.target.value); setFailed(false); }}
      onBlur={() => {
        focused.current = false;
        if (cancelled.current) { cancelled.current = false; return; }
        if (draft !== value) setFailed(!onCommit(draft));
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); cancelled.current = true;
          setDraft(value); setFailed(false); event.currentTarget.blur();
        }
      }} />
    {failed ? <p className='text-xs text-destructive'>{t('spaces.threeD.valueFailed')}</p> : null}
  </div>;
}
