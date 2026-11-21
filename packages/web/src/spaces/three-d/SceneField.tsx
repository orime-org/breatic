// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { cn } from '@web/lib/utils';
import { useTranslation } from '@web/i18n/use-translation';
import { whenBlurLeaves } from '@web/lib/blur-left';
import { useInlineEditExit } from '@web/lib/inline-edit-exit';

export interface SceneFieldDraft {
  text: string;
  failed: boolean;
  editing: boolean;
}

export interface SceneFieldDraftOwner {
  fieldDrafts: ReadonlyMap<string, SceneFieldDraft>;
  onFieldDraftChange: (key: string, draft: SceneFieldDraft | undefined) => void;
}

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
 * @param root0.draftKey - Object and field identity within the owning Space.
 * @param root0.draft - Temporary input retained by the Space's editor.
 * @param root0.onFieldDraftChange - Updates or ends this field's temporary edit.
 * @param root0.testId - Its test id.
 * @param root0.inline - Whether the caption sits before a narrow box in a labelled row instead of above it.
 * @returns A labelled input retaining unaccepted drafts.
 */
export const SceneField = React.memo(function SceneField({ label, value, disabled, numeric = false, spaceId, maxLength, onCommit, draftKey, draft, onFieldDraftChange, testId, inline = false }: {
  label: string; value: string; disabled: boolean; numeric?: boolean; spaceId: string; maxLength?: number; onCommit: (value: string) => boolean;
  draftKey: string; draft: SceneFieldDraft | undefined; onFieldDraftChange: SceneFieldDraftOwner['onFieldDraftChange']; testId?: string;
  inline?: boolean;
}): React.JSX.Element {
  const t = useTranslation();
  const id = React.useId();
  const text = draft?.text ?? value;
  const failed = draft?.failed ?? false;
  const input = React.useRef<HTMLInputElement>(null);
  const focused = React.useRef(false);
  React.useEffect(() => (): void => { focused.current = false; }, []);
  /**
   * Submit once, including when Enter is followed by blur.
   * @throws {never} Refusals are returned.
   */
  const commit = React.useCallback((): void => {
    if (!focused.current) return;
    focused.current = false;
    const rejected = text !== value && !onCommit(text);
    onFieldDraftChange(draftKey, rejected ? { text, failed: true, editing: false } : undefined);
  }, [text, value, onCommit, onFieldDraftChange, draftKey]);
  /**
   * Discard a draft before the keyboard moves out of the input.
   * @throws {never} Never.
   */
  const cancel = React.useCallback((): void => {
    focused.current = false;
    onFieldDraftChange(draftKey, undefined);
  }, [onFieldDraftChange, draftKey]);
  /**
   * Return keyboard ownership to the floating inspector.
   * @returns The panel or null.
   * @throws {never} Never.
   */
  const target = React.useCallback((): HTMLElement | null => input.current?.closest<HTMLElement>('[data-testid="scene-right-panel"]') ?? null, []);
  const exit = useInlineEditExit({ editing: draft?.editing ?? false, target, commit, cancel });
  const box = <Input ref={input} id={id} autoComplete='off' inputMode={numeric ? 'decimal' : 'text'} value={text} disabled={disabled} maxLength={maxLength}
    className={cn('h-8 min-w-0 text-xs', inline && 'w-16')} aria-invalid={failed} data-testid={testId}
    onFocus={() => { focused.current = true; onFieldDraftChange(draftKey, { text, failed, editing: true }); }}
    onChange={(event) => { onFieldDraftChange(draftKey, { text: event.target.value, failed: false, editing: true }); }}
    onBlur={() => whenBlurLeaves(spaceId, commit)}
    onKeyDown={exit.onKeyDown} onCompositionEnd={exit.onCompositionEnd} />;
  const caption = <Label htmlFor={id} className='text-xs text-muted-foreground'>{label}</Label>;
  return <div className='min-w-0 space-y-1'>
    {inline ? <div className='flex items-center gap-1'>{caption}{box}</div> : <>{caption}{box}</>}
    {failed ? <p className='text-xs text-destructive'>{t('spaces.threeD.valueFailed')}</p> : null}
  </div>;
});
