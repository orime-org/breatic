/**
 * AnnotationComposer — fixed-position overlay rendered for the one
 * pending annotation entry.
 *
 * Position calculation: pending entries store flow coordinates;
 * conversion to screen coords happens once at mount time via
 * `useReactFlow().flowToScreenPosition`. We intentionally don't
 * track viewport changes — if the user pans / zooms while the
 * composer is open, the composer stays where it appeared. Same UX
 * as `CanvasCommentComposer`, and it dodges the awkward "composer
 * follows pointer" feel that comes with reactive positioning.
 *
 * Visually layered above the canvas at z-[60] (matching the comment
 * composer) so it sits above ReactFlow handles + node toolbars but
 * below modals / dialogs.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useReactFlow } from '@xyflow/react';
import { Button } from '@/ui/button';
import { Icon } from '@/ui/icon';
import { useAnnotationActions } from './use-annotation-actions';

const MAX_CHARS = 200;

const AnnotationComposer: React.FC = () => {
  const { t } = useTranslation();
  const { flowToScreenPosition } = useReactFlow();
  const { pendingAnnotation, submitAnnotation, cancelAnnotation } = useAnnotationActions();
  const [value, setValue] = useState('');

  // Reset input when a new pending entry replaces the old one (e.g.
  // user cancelled then dropped again — same hook, fresh draft).
  useEffect(() => {
    setValue('');
  }, [pendingAnnotation?.id]);

  // Capture screen position once at mount and pin the overlay there.
  // Re-running this on every render would cause the composer to
  // "stick" to the canvas under pan/zoom, which feels wrong for a
  // transient input UI.
  const screenPos = useMemo(() => {
    if (!pendingAnnotation) return null;
    const p = flowToScreenPosition(pendingAnnotation.position);
    // Center the 240×112 composer over the drop point — feels
    // anchored to the spot the user picked, not floating above.
    return { x: p.x - 120, y: p.y - 56 };
    // We deliberately exclude `flowToScreenPosition` from the dep
    // array: it changes identity per render but its closure-captured
    // position is what we want frozen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAnnotation?.id]);

  const handleSubmit = useCallback(() => {
    if (!pendingAnnotation) return;
    submitAnnotation(pendingAnnotation.id, value);
    setValue('');
  }, [pendingAnnotation, submitAnnotation, value]);

  const handleCancel = useCallback(() => {
    if (!pendingAnnotation) return;
    cancelAnnotation(pendingAnnotation.id);
    setValue('');
  }, [pendingAnnotation, cancelAnnotation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleCancel, handleSubmit],
  );

  if (!pendingAnnotation || !screenPos) return null;

  const charCount = value.length;
  const canSend = value.trim().length > 0;

  return (
    <div
      className='fixed z-[60] w-[240px] rounded-[8px] border border-[#DBDBDB] bg-background-default-base p-2 shadow-[0_2px_6px_rgba(0,0,0,0.12)]'
      style={{ left: screenPos.x, top: screenPos.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className='relative rounded-[6px] bg-background-default-secondary px-2 py-1.5'>
        <textarea
          autoFocus
          rows={2}
          value={value}
          maxLength={MAX_CHARS}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t(
            'canvas.annotation.composerPlaceholder',
            '输入批注内容…(Enter 保存,Esc 取消)',
          )}
          className='h-[60px] w-full resize-none border-none bg-transparent px-0 pt-0 text-[12px] text-text-default-base outline-none placeholder:text-text-default-tertiary'
        />
        <div className='absolute bottom-1 right-1 flex items-center gap-2'>
          <span className='text-[11px] font-semibold text-text-default-tertiary'>
            {charCount}/{MAX_CHARS}
          </span>
          <Button
            type='primary'
            size='medium'
            shape='round'
            disabled={!canSend}
            icon={<Icon name='project-chat-send-icon' width={14} height={12} color='#fff' />}
            onClick={handleSubmit}
            className='!h-[24px] !w-[40px] !border-brand-base !bg-brand-base !py-0 !pl-3 !pr-2 hover:!border-brand-base hover:!bg-brand-base disabled:!border-background-neutral-secondary disabled:!bg-background-neutral-secondary'
            aria-label={t('canvas.annotation.send', '保存批注')}
          />
        </div>
      </div>
    </div>
  );
};

export default AnnotationComposer;
