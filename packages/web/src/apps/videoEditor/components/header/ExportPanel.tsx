import React, { useState, useRef, memo } from 'react';
import Select from '@/components/base/select';
import { message } from '@/components/base/message';
import Input from '@/components/base/input';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/base/button';
import { nanoid } from 'nanoid';
import { ExportSettingsModal } from './ExportSettingsModal';
import { useVideoEditorStore } from '@/hooks/useVideoEditorStore';
import { useProjectStore } from '@/hooks/useProjectStore';
import { exportAsMP4 } from '@/utils/videoEditor/videoExporter';
import { exportFrameAsPNG } from '@/utils/videoEditor/imageExporter';
import { exportAudio } from '@/utils/videoEditor/audioExporter';
import { getOssStsApi, uploadFileSuccessApi, saveWorkflowApi } from '@/apis/projectApi';
import { createOssClient } from '@/utils/ossClient';
import { generateVideoThumbnail, dataURLtoBlob } from '@/utils/mediaUtils';

interface ExportPanelProps {
  canvasRatio?: string;
  currentTime?: number;
  nodeId?: string;
  projectId?: string;
  yjsManager?: { newResultsFlagMap?: { push: (item: unknown) => void } } | null;
  /** Local-only: no OSS upload, no workflow / node persistence. */
  standalone?: boolean;
}

/**
 * Export panel for video editor output settings.
 */
const ExportPanel: React.FC<ExportPanelProps> = ({
  canvasRatio = '16:9',
  currentTime = 0,
  nodeId,
  projectId,
  standalone = false,
}) => {
  const { t } = useTranslation();
  const { clips, mediaItems } = useVideoEditorStore();
  const { updateNode, addNewResultFlag, newResultsFlag } = useProjectStore();
  const workflowId = projectId || '';
  const abortControllerRef = useRef<AbortController | null>(null);

  // Save export result to node data.
  const saveExportResult = (resourceUrl: string, assetType: 'image' | 'audio' | 'video', blob: Blob) => {
    if (standalone || !nodeId) return;

    // Standalone video editor has no CanvasDataProvider, so avoid canvas-context reads here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentData: any = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingExportResults = (currentData.exportResults as any[]) || [];

    // Build export result payload.
    const exportResult = {
      id: `export-${Date.now()}-${nanoid(9)}`,
      type: assetType, // 'image' | 'audio' | 'video'
      format: exportedFormat.toLowerCase(), // 'png', 'jpg', 'mp4', 'mov', 'mp3', 'wav', etc.
      result: resourceUrl,
      createTime: new Date().toISOString(),
      size: blob.size,
      mimeType: blob.type,
    };

    // Keep newest result at the front.
    const updatedExportResults = [exportResult, ...existingExportResults];

    // Update node data.
    if (!nodeId) return;
    updateNode(nodeId, {
      data: {
        exportResults: updatedExportResults,
      },
    });

    // Debug export result payload.
    // eslint-disable-next-line no-console
    console.log('📦 Export result saved to node:', {
      nodeId,
      exportResult,
      allExportResults: updatedExportResults,
    });
  };

  // Extract first video frame and upload to OSS.
  const uploadVideoThumbnail = async (videoUrl: string): Promise<string | undefined> => {
    if (standalone) return undefined;
    try {
      const { thumbnail: thumbnailBase64 } = await generateVideoThumbnail(videoUrl);
      if (!thumbnailBase64) {
        return undefined;
      }

      const blob = dataURLtoBlob(thumbnailBase64);
      const thumbnailFile = new File([blob], `thumbnail-${Date.now()}.jpg`, { type: 'image/jpeg' });

      // Fetch OSS STS credentials.
      const thumbnailStsResponse = await getOssStsApi({ asset_type: 'image' });
      const {
        access_key_id: thumb_access_key_id,
        access_key_secret: thumb_access_key_secret,
        security_token: thumb_security_token,
        bucket: thumb_bucket,
        upload_file_name: thumb_upload_file_name,
      } = thumbnailStsResponse.data;

      // Init OSS client with token refresh.
      const thumbnailClient = createOssClient(
        {
          access_key_id: thumb_access_key_id,
          access_key_secret: thumb_access_key_secret,
          security_token: thumb_security_token,
          bucket: thumb_bucket,
          upload_file_name: thumb_upload_file_name,
        },
        'image'
      );

      // Upload thumbnail to OSS.
      await thumbnailClient.put(thumb_upload_file_name, thumbnailFile, {
        meta: {
          temp: 'demo',
          uid: 0,
          pid: 0,
        },
        mime: 'image/jpeg',
        headers: {
          'Content-Type': 'image/jpeg',
        },
      });

      // Notify backend and get resource URL.
      const thumbnailSuccessResponse = await uploadFileSuccessApi({
        source_type: 'exported',
        upload_file_name: thumb_upload_file_name,
        workflow_id: workflowId,
        asset_type: 'image',
        need_save: false,
      });

      if (thumbnailSuccessResponse?.data?.resource_url) {
        return thumbnailSuccessResponse.data.resource_url;
      }
    } catch (error) {
      console.error('Failed to extract first video frame:', error);
    }
    return undefined;
  };

  // Upload exported file.
  const uploadExportedFile = async (blob: Blob, assetType: 'image' | 'audio' | 'video'): Promise<string | null> => {
    if (standalone) {
      const url = URL.createObjectURL(blob);
      setIsUploading(false);
      return url;
    }

    if (!workflowId) {
      message.warning('Workflow ID is missing, upload skipped');
      return null;
    }

    setIsUploading(true);
    try {
      // 1) Fetch OSS STS credentials and upload key.
      const stsResponse = await getOssStsApi({ asset_type: assetType });
      const {
        access_key_id,
        access_key_secret,
        security_token,
        bucket,
        upload_file_name,
      } = stsResponse.data;

      // 2) Init OSS client with token refresh.
      const client = createOssClient(
        {
          access_key_id,
          access_key_secret,
          security_token,
          bucket,
          upload_file_name,
        },
        assetType
      );

      // 3) Convert Blob to File.
      const file = new File([blob], `export.${exportedFormat.toLowerCase()}`, { type: blob.type });

      // 4) Upload file to OSS.
      const options = {
        meta: {
          temp: 'demo',
          uid: 0,
          pid: 0,
        },
        mime: blob.type,
        headers: {
          'Content-Type': blob.type,
        },
      };

      await client.put(upload_file_name, file, options);

      // 5) Notify backend and get resource URL.
      const successResponse = await uploadFileSuccessApi({
        source_type: 'exported',
        upload_file_name: upload_file_name,
        workflow_id: workflowId,
        asset_type: assetType,
      });

      if (!successResponse?.data?.resource_url) {
        message.warning('Failed to get resource URL');
        return null;
      }

      const resourceUrl = successResponse.data.resource_url;
      // eslint-disable-next-line no-console
      console.log(resourceUrl,'resourceUrl');

      // Save export result to node data.
      saveExportResult(resourceUrl, assetType, blob);

      return resourceUrl;
    } catch (error) {
      console.error('Upload failed:', error);
      message.error('File upload failed');
      return null;
    } finally {
      setIsUploading(false);
    }
  };

  // Base canvas size by ratio.
  const getBaseCanvasSize = (ratio: string): { width: number; height: number } => {
    switch (ratio) {
      case '16:9':
        return { width: 1920, height: 1080 };
      case '9:16':
        return { width: 1080, height: 1920 };
      case '1:1':
        return { width: 1080, height: 1080 };
      default:
        return { width: 1920, height: 1080 };
    }
  };

  // Export config state.
  const [exportConfig, setExportConfig] = useState({
    type: 'VIDEO',
    videoFormat: 'MP4',
    imageFormat: 'PNG',
    resolution: '1920x1080',
    frameRate: 30,
    bitrate: 'recommended',
    bitrateMode: 'CBR',
    customBitrate: '5000',
    codec: 'libx264',
    audioSampleRate: 44100,
    audioQuality: 'aac_192',
    audioFormat: 'MP3',
    audioBitrate: '192',
    audioExportSampleRate: 44100,
  });

  // Export runtime state.
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportComplete, setExportComplete] = useState(false);
  const [exportedBlob, setExportedBlob] = useState<Blob | null>(null);
  const [exportedFormat, setExportedFormat] = useState<string>('');
  const [isUploading, setIsUploading] = useState(false);

  // Resolution options by ratio.
  const getResolutionOptions = () => {
    switch (canvasRatio) {
      case '16:9':
        return [
          { value: '854x480', label: '480P (854x480)' },
          { value: '1280x720', label: '720P (1280x720)' },
          { value: '1920x1080', label: '1080P (1920x1080)' },
          { value: '2560x1440', label: '2K (2560x1440)' },
          { value: '3840x2160', label: '4K (3840x2160)' },
          { value: '7680x4320', label: '8K (7680x4320)' },
        ];
      case '9:16':
        return [
          { value: '480x854', label: '480P (480x854)' },
          { value: '720x1280', label: '720P (720x1280)' },
          { value: '1080x1920', label: '1080P (1080x1920)' },
          { value: '1440x2560', label: '2K (1440x2560)' },
          { value: '2160x3840', label: '4K (2160x3840)' },
          { value: '4320x7680', label: '8K (4320x7680)' },
        ];
      case '1:1':
        return [
          { value: '480x480', label: '480P (480x480)' },
          { value: '720x720', label: '720P (720x720)' },
          { value: '1080x1080', label: '1080P (1080x1080)' },
          { value: '1440x1440', label: '2K (1440x1440)' },
          { value: '2160x2160', label: '4K (2160x2160)' },
          { value: '4320x4320', label: '8K (4320x4320)' },
        ];
    }
    return [];
  };

  // Export image.
  const exportAsImage = async () => {
    try {
      const signal = abortControllerRef.current?.signal;
      if (signal?.aborted) {
        throw new DOMException('Export was cancelled', 'AbortError');
      }

      const blob = await exportFrameAsPNG(
        clips,
        mediaItems,
        currentTime,
        exportConfig.resolution,
        setExportProgress,
        getBaseCanvasSize,
        exportConfig.imageFormat,
        canvasRatio,
        signal
      );

      if (signal?.aborted) {
        throw new DOMException('Export was cancelled', 'AbortError');
      }

      setExportedBlob(blob);
      setExportProgress(100);

      setIsUploading(true);
      const resourceUrl = await uploadExportedFile(blob, 'image');
      setIsUploading(false);

      setExportComplete(true);
      if (!standalone && nodeId && workflowId) {
        addNewResultFlag(nodeId, 'exported');
        const updatedFlags = [...newResultsFlag, { nodeId, type: 'exported' as const, time: Date.now() }];
        await saveWorkflowApi({
          id: workflowId,
          new_results_flag: updatedFlags,
          workflow_screen: resourceUrl ?? undefined,
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      console.error('Image export failed:', error);
      setIsExporting(false);
      message.error(`Image export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  // Export video.
  const exportAsVideo = async () => {
    try {
      const signal = abortControllerRef.current?.signal;
      if (signal?.aborted) {
        throw new DOMException('Export was cancelled', 'AbortError');
      }

      let actualBitrate = exportConfig.bitrate;
      if (exportConfig.bitrate === 'custom') {
        actualBitrate = `${exportConfig.customBitrate}k`;
      }

      const blob = await exportAsMP4(
        clips,
        mediaItems,
        canvasRatio,
        setExportProgress,
        {
          resolution: exportConfig.resolution,
          frameRate: exportConfig.frameRate,
          bitrate: actualBitrate,
          bitrateMode: exportConfig.bitrateMode,
          codec: exportConfig.codec,
          audioSampleRate: exportConfig.audioSampleRate,
          audioQuality: exportConfig.audioQuality,
          format: exportConfig.videoFormat,
        },
        signal
      );

      if (signal?.aborted) {
        throw new DOMException('Export was cancelled', 'AbortError');
      }

      setExportedBlob(blob);
      setExportProgress(100);

      setIsUploading(true);
      const resourceUrl = await uploadExportedFile(blob, 'video');
      setIsUploading(false);

      setExportComplete(true);
      if (!standalone && nodeId && workflowId) {
        addNewResultFlag(nodeId, 'exported');
        let thumbnailUrl: string | undefined;
        if (resourceUrl) {
          thumbnailUrl = await uploadVideoThumbnail(resourceUrl);
        }
        const updatedFlags = [...newResultsFlag, { nodeId, type: 'exported' as const, time: Date.now() }];
        await saveWorkflowApi({
          id: workflowId,
          new_results_flag: updatedFlags,
          workflow_screen: thumbnailUrl,
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      console.error('Video export failed:', error);
      setIsExporting(false);
      message.error(`Video export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  // Export audio.
  const exportAsAudio = async () => {
    try {
      const signal = abortControllerRef.current?.signal;
      if (signal?.aborted) {
        throw new DOMException('Export was cancelled', 'AbortError');
      }


      const blob = await exportAudio(
        clips,
        mediaItems,
        setExportProgress,
        {
          format: exportConfig.audioFormat,
          bitrate: exportConfig.audioBitrate,
          sampleRate: exportConfig.audioExportSampleRate,
        },
        signal
      );

      if (signal?.aborted) {
        throw new DOMException('Export was cancelled', 'AbortError');
      }

      setExportedBlob(blob);
      setExportProgress(100);

      setIsUploading(true);
      await uploadExportedFile(blob, 'audio');
      setIsUploading(false);

      setExportComplete(true);
      if (!standalone && nodeId && workflowId) {
        addNewResultFlag(nodeId, 'exported');
        const updatedFlags = [...newResultsFlag, { nodeId, type: 'exported' as const, time: Date.now() }];
        await saveWorkflowApi({
          id: workflowId,
          new_results_flag: updatedFlags,
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      console.error('Audio export failed:', error);
      setIsExporting(false);
      message.error(`Audio export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  // Handle export button click.
  //
  // Timeline Exporter is under product redesign (memory:
  // project_t3_batch_status) — the in-browser ffmpeg.wasm export path
  // is unsuitable long-term and the server-side flow hasn't shipped
  // yet. Ban the entry point and surface a "coming soon" message.
  // The internal `exportAsImage / exportAsVideo / exportAsAudio`
  // helpers + the three Exporter utilities + the `@ffmpeg/*` package
  // all live until the follow-up PR that rewrites ExportPanel into a
  // "Coming Soon" placeholder.
  const handleExport = async () => {
    message.warning(
      'Export is being redesigned and is temporarily unavailable. Coming soon.',
    );
  };

  // Download exported blob.
  const handleDownload = () => {
    if (exportedBlob) {
      const url = URL.createObjectURL(exportedBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `export.${exportedFormat.toLowerCase()}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };


  // Cancel export.
  const handleCancelExport = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsExporting(false);
    setExportProgress(0);
    setExportComplete(false);
    setExportedBlob(null);
  };

  return (
    <div className='w-[220px]'>
      <div className='mb-3 text-xs font-medium text-text-default-secondary'>
        {t('export.title')}
      </div>

      {/* Export type */}
      <div className='mb-3'>
        <label className='block mb-1 text-xs text-text-default-tertiary'>
          {t('export.exportType')}
        </label>
        <Select
          value={exportConfig.type}
          onChange={(value) => setExportConfig((prev) => ({ ...prev, type: String(value) }))}
          className='w-full h-[26px]'
          size='small'
          options={[
            { value: 'VIDEO', label: t('export.video') },
            { value: 'IMAGE', label: t('export.image') },
            { value: 'AUDIO', label: t('export.audio') },
          ]}
        />
      </div>

      {/* Video format */}
      {exportConfig.type === 'VIDEO' && (
        <div className='mb-3'>
          <label className='block mb-1 text-xs text-text-default-tertiary'>
            {t('export.videoFormat')}
          </label>
          <Select
            value={exportConfig.videoFormat}
            onChange={(value) => setExportConfig((prev) => ({ ...prev, videoFormat: String(value) }))}
            className='w-full h-[26px]'
            size='small'
            options={[
              { value: 'MP4', label: 'MP4' },
              { value: 'MOV', label: 'MOV' },
            ]}
          />
        </div>
      )}

      {/* Image format */}
      {exportConfig.type === 'IMAGE' && (
        <>
          <div className='mb-3'>
            <label className='block mb-1 text-xs text-text-default-tertiary'>
              {t('export.imageFormat')}
            </label>
            <Select
              value={exportConfig.imageFormat}
              onChange={(value) => setExportConfig((prev) => ({ ...prev, imageFormat: String(value) }))}
              className='w-full h-[26px]'
              size='small'
              options={[
                { value: 'PNG', label: 'PNG' },
                { value: 'JPG', label: 'JPG' },
              ]}
            />
          </div>

          {/* Image resolution */}
          <div className='mb-3'>
            <label className='block mb-1 text-xs text-text-default-tertiary'>
              {t('export.resolution')}
            </label>
            <Select
              value={exportConfig.resolution}
              onChange={(value) => setExportConfig((prev) => ({ ...prev, resolution: String(value) }))}
              className='w-full h-[26px]'
              size='small'
              options={getResolutionOptions()}
            />
          </div>
        </>
      )}

      {/* Video settings */}
      {exportConfig.type === 'VIDEO' && (
        <>
          {/* Resolution */}
          <div className='mb-3'>
            <label className='block mb-1 text-xs text-text-default-tertiary'>
              {t('export.resolution')}
            </label>
            <Select
              value={exportConfig.resolution}
              onChange={(value) => setExportConfig((prev) => ({ ...prev, resolution: String(value) }))}
              className='w-full h-[26px]'
              size='small'
              options={getResolutionOptions()}
            />
          </div>

          {/* Frame rate */}
          <div className='mb-3'>
            <label className='block mb-1 text-xs text-text-default-tertiary'>
              {t('export.frameRate')}
            </label>
            <Select
              value={exportConfig.frameRate}
              onChange={(value) => setExportConfig((prev) => ({ ...prev, frameRate: Number(value) }))}
              className='w-full h-[26px]'
              size='small'
              options={[
                { value: 24, label: '24 fps' },
                { value: 25, label: '25 fps' },
                { value: 29.97, label: '29.97 fps' },
                { value: 30, label: '30 fps' },
                { value: 50, label: '50 fps' },
                { value: 59.94, label: '59.94 fps' },
                { value: 60, label: '60 fps' },
              ]}
            />
          </div>

          {/* Video bitrate */}
          <div className='mb-3'>
            <label className='block mb-1 text-xs text-text-default-tertiary'>
              {t('export.bitrate')}
            </label>
            <Select
              value={exportConfig.bitrate}
              onChange={(value) => setExportConfig((prev) => ({ ...prev, bitrate: String(value) }))}
              className='w-full h-[26px]'
              size='small'
              options={[
                {
                  value: 'lower',
                  label: t('export.bitrateOptions.lower'),
                },
                {
                  value: 'recommended',
                  label: t('export.bitrateOptions.recommended'),
                },
                {
                  value: 'higher',
                  label: t('export.bitrateOptions.higher'),
                },
                {
                  value: 'custom',
                  label: t('export.bitrateOptions.custom'),
                },
              ]}
            />
          </div>

          {/* Custom bitrate */}
          {exportConfig.bitrate === 'custom' && (
            <>
              <div className='mb-3'>
                <label className='block mb-1 text-xs text-text-default-tertiary'>
                  {t('export.bitrateMode')}
                </label>
                <Select
                  value={exportConfig.bitrateMode}
                  onChange={(value) => setExportConfig((prev) => ({ ...prev, bitrateMode: String(value) }))}
                  className='w-full h-[26px]'
                  size='small'
                  options={[
                    {
                      value: 'CBR',
                      label: t('export.bitrateModeOptions.cbr'),
                    },
                    {
                      value: 'VBR',
                      label: t('export.bitrateModeOptions.vbr'),
                    },
                  ]}
                />
              </div>
              <div className='mb-3'>
                <label className='block mb-1 text-xs text-text-default-tertiary'>
                  {t('export.customBitrate')} (KBPS)
                </label>
                <Input
                  inputType='number'
                  value={exportConfig.customBitrate}
                  onChange={(e) => setExportConfig((prev) => ({ ...prev, customBitrate: e.target.value }))}
                  placeholder='5000'
                  min={100}
                  max={100000}
                  className='w-full h-[26px] text-xs rounded'
                />
              </div>
            </>
          )}

          {/* Video codec */}
          <div className='mb-3'>
            <label className='block mb-1 text-xs text-text-default-tertiary'>
              {t('export.codec')}
            </label>
            <Select
              value={exportConfig.codec}
              onChange={(value) => setExportConfig((prev) => ({ ...prev, codec: String(value) }))}
              className='w-full h-[26px]'
              size='small'
              options={[
                { value: 'libx264', label: 'H.264' },
                { value: 'libx265', label: 'HEVC' },
                { value: 'libx265_alpha', label: 'HEVC (Alpha)' },
                { value: 'libx265_422', label: 'HEVC (422)' },
                { value: 'libaom-av1', label: 'AV1' },
                { value: 'rle', label: 'RLE' },
              ]}
            />
          </div>

          {/* Audio sample rate */}
          <div className='mb-3'>
            <label className='block mb-1 text-xs text-text-default-tertiary'>
              {t('export.audioSampleRate')}
            </label>
            <Select
              value={exportConfig.audioSampleRate}
              onChange={(value) => setExportConfig((prev) => ({ ...prev, audioSampleRate: Number(value) }))}
              className='w-full h-[26px]'
              size='small'
              options={[
                { value: 44100, label: '44100 Hz' },
                { value: 48000, label: '48000 Hz' },
              ]}
            />
          </div>

          {/* Audio quality */}
          <div className='mb-3'>
            <label className='block mb-1 text-xs text-text-default-tertiary'>
              {t('export.audioQuality')}
            </label>
            <Select
              value={exportConfig.audioQuality}
              onChange={(value) => setExportConfig((prev) => ({ ...prev, audioQuality: String(value) }))}
              className='w-full h-[26px]'
              size='small'
              options={[
                { value: 'aac_192', label: 'AAC 192 kbps' },
                { value: 'aac_256', label: 'AAC 256 kbps' },
                { value: 'aac_320', label: 'AAC 320 kbps' },
                {
                  value: 'pcm',
                  label: t('export.audioQualityOptions.pcm'),
                },
              ]}
            />
          </div>
        </>
      )}

      {/* Audio settings */}
      {exportConfig.type === 'AUDIO' && (
        <>
          {/* Audio format */}
          <div className='mb-3'>
            <label className='block mb-1 text-xs text-text-default-tertiary'>
              {t('export.audioFormat')}
            </label>
            <Select
              value={exportConfig.audioFormat}
              onChange={(value) => setExportConfig((prev) => ({ ...prev, audioFormat: String(value) }))}
              className='w-full h-[26px]'
              size='small'
              options={[
                { value: 'MP3', label: 'MP3' },
                { value: 'WAV', label: 'WAV' },
                { value: 'AAC', label: 'AAC' },
                { value: 'FLAC', label: 'FLAC' },
                { value: 'AIFF', label: 'AIFF' },
                { value: 'OGG', label: 'OGG' },
              ]}
            />
          </div>

          {/* Audio bitrate */}
          <div className='mb-3'>
            <label className='block mb-1 text-xs text-text-default-tertiary'>
              {t('export.audioBitrate')}
            </label>
            <Select
              value={exportConfig.audioBitrate}
              onChange={(value) => setExportConfig((prev) => ({ ...prev, audioBitrate: String(value) }))}
              className='w-full h-[26px]'
              size='small'
              options={[
                { value: '192', label: '192 kbps' },
                { value: '256', label: '256 kbps' },
                { value: '320', label: '320 kbps' },
              ]}
            />
          </div>

          {/* Audio sample rate */}
          <div className='mb-3'>
            <label className='block mb-1 text-xs text-text-default-tertiary'>
              {t('export.sampleRate')}
            </label>
            <Select
              value={exportConfig.audioExportSampleRate}
              onChange={(value) => setExportConfig((prev) => ({ ...prev, audioExportSampleRate: Number(value) }))}
              className='w-full h-[26px]'
              size='small'
              options={[
                { value: 44100, label: '44100 Hz' },
                { value: 48000, label: '48000 Hz' },
              ]}
            />
          </div>
        </>
      )}

      {/* Export button */}
      <Button
        type='primary'
        bordered={false}
        block
        className='h-[26px] mt-2.5 text-xs'
        onClick={handleExport}
      >
        {t('common.export')}
      </Button>

      {/* Export progress modal */}
      <ExportSettingsModal
        isExporting={isExporting}
        exportProgress={exportProgress}
        exportComplete={exportComplete}
        exportedFormat={exportedFormat}
        isUploading={isUploading}
        setIsExporting={setIsExporting}
        setExportProgress={setExportProgress}
        setExportComplete={setExportComplete}
        setExportedBlob={setExportedBlob}
        handleDownload={handleDownload}
        handleCancelExport={handleCancelExport}
      />
    </div>
  );
};

export default memo(ExportPanel);
