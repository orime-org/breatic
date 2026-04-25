import React, { useEffect, useState } from 'react';
import { Icon } from '@/components/base/icon';
import Video from '@/apps/project/components/canvas/common/Video';
import AudioWaveformPlayer from '@/apps/project/components/canvas/common/AudioWaveformPlayer';
import { getVideoMetaFromUrl } from '@/utils/mediaUtils';

/** Resource modality for composer previews, chips, and @-panel rows. */
export type AgentResourceType = 'image' | 'file' | 'text' | 'audio' | 'video';

/** Payload for {@link AgentResourcePreviewContent} (same shape as composer chip preview). */
export type AgentPreviewResource = {
  url: string;
  label: string;
  type: AgentResourceType;
};

export type AgentResourcePreviewContentProps = {
  resource: AgentPreviewResource;
  videoSize?: { width: number; height: number } | null;
  /** For `text`, body to show; defaults to {@link AgentPreviewResource.url} in callers when that holds plain text. */
  textContent?: string | null;
};

/**
 * Renders image / video / audio / text / file preview (aligned with composer chip popover in `AgentInput`).
 *
 * @param props.resource - URL or text payload and modality.
 * @param props.videoSize - Required when `resource.type === 'video'` (from {@link useAgentResourcePreviewVideoSize}).
 * @param props.textContent - Optional override for text body.
 */
export function AgentResourcePreviewContent({
  resource,
  videoSize,
  textContent,
}: AgentResourcePreviewContentProps): React.ReactElement | null {
  if (resource.type === 'video') {
    if (!videoSize) {
      return <div className='p-3 text-xs text-[var(--color-text-default-tertiary)]'>Loading…</div>;
    }

    return (
      <div
        className='relative max-h-[60vh] max-w-[90vw] bg-black'
        style={{ width: videoSize.width, height: videoSize.height }}
      >
        <Video
          key={resource.url}
          src={resource.url}
          showControlBar
          className='absolute inset-0 h-full w-full !rounded-none'
        />
      </div>
    );
  }

  if (resource.type === 'image') {
    return (
      <img
        src={resource.url}
        alt={resource.label}
        className='max-w-[280px] max-h-[280px] w-auto h-auto object-contain block'
      />
    );
  }

  if (resource.type === 'audio') {
    return <AudioWaveformPlayer label={resource.label} src={resource.url} />;
  }

  if (resource.type === 'text') {
    const content = textContent ?? resource.label;
    return (
      <div className='max-w-[320px] max-h-[240px] overflow-auto'>
        <div className='text-sm text-[var(--color-text-default-base)] whitespace-pre-wrap break-words font-sans'>
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-col items-center gap-2 py-4 px-6 max-w-[200px]'>
      <span className='w-12 h-12 rounded-lg shrink-0 inline-flex items-center justify-center bg-[var(--color-background-default-tertiary)]'>
        <Icon name='project-chat-doc-icon' width={24} height={24} color='var(--color-icon-base)' />
      </span>
      <span className='text-sm text-[var(--color-text-default-base)] truncate w-full text-center'>
        {resource.label}
      </span>
    </div>
  );
}

/**
 * Loads natural video dimensions and fits them to the same bounds as the composer chip preview.
 *
 * @param open - Whether the preview surface is visible.
 * @param resource - Active item; only `type === 'video'` with a URL triggers a fetch.
 * @returns Sized bounds for the video container, or `null` while loading / inactive.
 */
export function useAgentResourcePreviewVideoSize(
  open: boolean,
  resource: AgentPreviewResource | null,
): { width: number; height: number } | null {
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (!open || !resource || resource.type !== 'video' || !resource.url) {
      setVideoSize(null);
      return;
    }
    let cancelled = false;
    setVideoSize(null);
    getVideoMetaFromUrl(resource.url).then((meta) => {
      if (cancelled) return;
      if (meta.width && meta.height) {
        const maxW = 280;
        const maxH = 200;
        const ratio = meta.width / meta.height;
        let width = Math.min(maxW, meta.width);
        let height = Math.round(width / ratio);
        if (height > maxH) {
          height = maxH;
          width = Math.round(height * ratio);
        }
        setVideoSize({ width: Math.max(250, width), height: Math.round(Math.max(250, width) / ratio) });
      } else {
        setVideoSize({ width: 280, height: 200 });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, resource]);

  return videoSize;
}
