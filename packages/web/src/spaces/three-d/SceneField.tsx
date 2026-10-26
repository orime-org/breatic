// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { useTranslation } from '@web/i18n/use-translation';
import { whenBlurLeaves } from '@web/lib/blur-left';
import { useInlineEditExit } from '@web/lib/inline-edit-exit';

/**
 * Preserve invalid numeric/name drafts until the user corrects or cancels them.
 * @param root0 - Scene identity and editing properties from the Space host.
 * @param root0.label - Visible caption associated with the input.
 * @param root0.value - Current numeric value to format or committed field text.
 * @param root0.disabled - Whether current editing eligibility disables this field.
 * @param root0.numeric - Whether the input requests decimal text entry.
 * @param root0.spaceId - The Space whose visibility owns blur submission.
 * @param root0.maxLength - Existing schema limit for a name field.
 * @param root0.onCommit - Applies a submitted draft and reports whether it was accepted.
 * @returns A labelled input retaining unaccepted drafts.
 */
export const SceneField = React.memo(function SceneField({ label, value, disabled, numeric = false, spaceId, maxLength, onCommit }: {
  label: string; value: string; disabled: boolean; numeric?: boolean; spaceId: string; maxLength?: number; onCommit: (value: string) => boolean;
}): React.JSX.Element {
  const t = useTranslation();
  const id = React.useId();
  const [draft, setDraft] = React.useState(value);
  const [failed, setFailed] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const focused = React.useRef(false);
  React.useEffect(() => {
    if (!focused.current && !failed) setDraft(value);
  }, [value, failed, editing]);
  /**
   * Submit once, including when Enter is followed by blur.
   * @throws {never} Refusals are returned.
   */
  const commit = React.useCallback((): void => {
    if (!focused.current) return;
    focused.current = false;
    setEditing(false);
    if (draft !== value) setFailed(!onCommit(draft));
  }, [draft, value, onCommit]);
  /**
   * Discard a draft before the keyboard moves out of the input.
   * @throws {never} Never.
   */
  const cancel = React.useCallback((): void => {
    focused.current = false;
    setEditing(false);
    setDraft(value);
    setFailed(false);
  }, [value]);
  /**
   * Return keyboard ownership to the floating inspector.
   * @returns The panel or null.
   * @throws {never} Never.
   */
  const target = React.useCallback((): HTMLElement | null => input.current?.closest<HTMLElement>('[data-testid="scene-right-panel"]') ?? null, []);
  const exit = useInlineEditExit({ editing, target, commit, cancel });
  return <div className='min-w-0 space-y-1'>
    <Label htmlFor={id} className='text-xs text-muted-foreground'>{label}</Label>
    <Input ref={input} id={id} autoComplete='off' inputMode={numeric ? 'decimal' : 'text'} value={draft} disabled={disabled} maxLength={maxLength}
      className='h-8 min-w-0 text-xs' aria-invalid={failed}
      onFocus={() => { focused.current = true; setEditing(true); }}
      onChange={(event) => { setDraft(event.target.value); setFailed(false); }}
      onBlur={() => whenBlurLeaves(spaceId, commit)}
      onKeyDown={exit.onKeyDown} onCompositionEnd={exit.onCompositionEnd} />
    {failed ? <p className='text-xs text-destructive'>{t('spaces.threeD.valueFailed')}</p> : null}
  </div>;
});
