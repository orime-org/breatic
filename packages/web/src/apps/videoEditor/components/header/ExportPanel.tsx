import React, { memo } from 'react';
import { Icon } from '@/components/base/icon';

/**
 * Timeline export — placeholder while the feature is being redesigned.
 *
 * The previous in-browser implementation drove ffmpeg.wasm via three
 * Exporter utilities (videoExporter / audioExporter / imageExporter)
 * to assemble multi-track timeline output client-side. Per memory
 * `project_t3_batch_status`, that path is being retired in favour of
 * a server-side rendering pipeline that hasn't landed yet.
 *
 * Until then, the panel shows a neutral "Coming Soon" message so
 * users don't trigger the legacy code path. ExportPanelProps stays
 * unchanged so the upstream TopBar mount-site doesn't need to move.
 */

interface ExportPanelProps {
  canvasRatio?: string;
  currentTime?: number;
  nodeId?: string;
  projectId?: string;
  yjsManager?: { newResultsFlagMap?: { push: (item: unknown) => void } } | null;
  /** Local-only: no OSS upload, no workflow / node persistence. */
  standalone?: boolean;
}

const ExportPanel: React.FC<ExportPanelProps> = (_props) => {
  return (
    <div className='flex w-[320px] flex-col items-center gap-3 px-6 py-8 text-center'>
      <div className='flex h-12 w-12 items-center justify-center rounded-full bg-background-default-base-hover'>
        <Icon name='videoNode-hdr-conversion' width={24} height={24} color='var(--color-icon-secondary)' />
      </div>
      <div className='text-[14px] font-semibold text-text-default-base'>
        Export coming soon
      </div>
      <div className='text-[12px] leading-relaxed text-text-default-secondary'>
        Timeline export is being redesigned and is temporarily unavailable.
        We&apos;ll bring it back with a faster, server-side rendering flow.
      </div>
    </div>
  );
};

export default memo(ExportPanel);
