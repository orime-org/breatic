/**
 * AnnotationNode — sticky-note style read-only canvas node showing
 * one annotation's text body, creator, and creation time.
 *
 * Edit / delete are V1-deferred — the v13 spec lists them under the
 * right-click menu (F9 #127) which lands separately. Today the only
 * way to remove an annotation is the standard delete-key on the
 * selected node; the only way to change the text is delete +
 * redrop.
 *
 * The component reads from Yjs (canvas data context). Pre-submit
 * state lives in LocalPending, surfaced by AnnotationComposer; this
 * component never sees pending entries.
 */
import React, { memo } from 'react';
import { type NodeProps } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { useCanvasData } from '@/spaces/canvas/contexts/CanvasDataContext';
import { Icon } from '@/ui/icon';

interface AnnotationNodeData {
  name?: string;
  content?: string;
  createdBy?: string;
  createdAt?: number;
}

/** Format `createdAt` as a relative-time tag — "刚刚", "5 分钟前", "3 小时前", "更早". */
function formatRelativeTime(
  createdAt: number | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!createdAt) return '';
  const diff = Date.now() - createdAt;
  if (diff < 60_000) return t('canvas.annotation.timeJustNow', { defaultValue: '刚刚' });
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return t('canvas.annotation.timeMinutesAgo', { count: mins, defaultValue: '{{count}} 分钟前' });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('canvas.annotation.timeHoursAgo', { count: hours, defaultValue: '{{count}} 小时前' });
  return t('canvas.annotation.timeEarlier', { defaultValue: '更早' });
}

const AnnotationNode: React.FC<NodeProps> = ({ id, selected }) => {
  const { t } = useTranslation();
  const { nodes } = useCanvasData();
  const currentNode = nodes.find((n) => n.id === id);
  const data = (currentNode?.data ?? {}) as AnnotationNodeData;

  const text = data.content ?? '';
  const initial = (data.createdBy ?? '').trim().slice(0, 1).toUpperCase() || 'M';
  const timeLabel = formatRelativeTime(data.createdAt, t);

  return (
    <div
      className={
        'pointer-events-auto w-[200px] rounded-[10px] border bg-[#FFF8C5] px-3 py-2 shadow-md ' +
        (selected
          ? 'border-border-utilities-selected outline outline-2 outline-border-utilities-selected/30'
          : 'border-[#F5DC65]')
      }
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className='mb-1 flex items-center gap-2'>
        <span className='inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-base text-[10px] font-bold text-white'>
          {initial}
        </span>
        <Icon name='base-add-comment' width={12} height={12} className='text-text-default-tertiary' />
        <span className='ml-auto text-[10px] text-text-default-tertiary'>{timeLabel}</span>
      </div>
      <div className='whitespace-pre-wrap break-words text-[12px] leading-5 text-[#3F3815]'>
        {text || (
          <span className='italic text-text-default-tertiary'>
            {t('canvas.annotation.empty', '(空批注)')}
          </span>
        )}
      </div>
    </div>
  );
};

export default memo(AnnotationNode);
