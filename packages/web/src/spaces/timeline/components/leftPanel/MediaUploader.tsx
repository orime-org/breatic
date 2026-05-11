import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import Upload from '@/ui/upload';
import { message } from '@/ui/message';
import { MediaItem } from '@/spaces/timeline/types';
import { Icon } from '@/ui/icon';
import { getImageMeta, getVideoMeta, getAudioMeta, extractThumbWithVideoElement } from '@/utils/mediaUtils';

type MediaType = 'video' | 'audio' | 'image';
type UploadType = 'folder' | 'image' | 'audio' | 'video';

interface MediaUploaderProps {
  onMediaAdd: (item: MediaItem) => void;
  uploadType?: UploadType;
  onUploadStart?: (type?: MediaType) => void;
  onUploadEnd?: (type?: MediaType) => void;
  projectId?: string;
}

interface UploadResult {
  id: string;
  name: string;
  type: MediaType;
  url: string;
  thumbnail?: string;
  duration?: number;
  width?: number;
  height?: number;
  fileInfo: {
    name: string;
    type: string;
    size: number;
  };
}

const getMediaType = (mimeType?: string): MediaType => {
  if (!mimeType) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'image';
};

const MediaUploader: React.FC<MediaUploaderProps> = ({
  onMediaAdd,
  uploadType = 'folder',
  onUploadStart,
  onUploadEnd,
}) => {
  const { t } = useTranslation();
  const beforeUpload = () => true;

  const createMediaItem = async (type: MediaType, url: string, file: File): Promise<UploadResult> => {
    const timestamp = Date.now();
    const baseItem: UploadResult = {
      id: `media-${type}-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name || `${type}-${timestamp}`,
      type,
      url,
      fileInfo: {
        name: file.name,
        type: file.type,
        size: file.size,
      },
    };

    if (type === 'image') {
      const meta = await getImageMeta(file);
      return {
        ...baseItem,
        width: meta.width,
        height: meta.height,
        thumbnail: url,
      };
    }

    if (type === 'video') {
      const [videoMeta, thumbnailBase64] = await Promise.all([
        getVideoMeta(file),
        extractThumbWithVideoElement(file),
      ]);
      return {
        ...baseItem,
        duration: videoMeta.duration,
        width: videoMeta.width,
        height: videoMeta.height,
        thumbnail: thumbnailBase64,
      };
    }

    if (type === 'audio') {
      const audioMeta = await getAudioMeta(file);
      return {
        ...baseItem,
        duration: audioMeta.duration,
      };
    }

    return baseItem;
  };

  const customRequest = async (options: {
    file: File;
    onProgress: (percent: number) => void;
    onSuccess: (response: unknown) => void;
    onError: (error: Error) => void;
  }) => {
    const { file, onProgress, onSuccess, onError } = options;
    const uploadFile = file as File;
    const type = getMediaType(uploadFile.type);

    onUploadStart?.(type);

    try {
      onProgress(20);
      const objectUrl = URL.createObjectURL(uploadFile);
      onProgress(70);
      const newMediaItem = await createMediaItem(type, objectUrl, uploadFile);
      onProgress(100);
      onMediaAdd(newMediaItem as MediaItem);
      onSuccess?.(objectUrl);
    } catch (error) {
      console.error('File upload error:', error);
      message.error(t('mediaUploader.fileProcessFailed', 'File processing failed'));
      onError?.(error as Error);
    } finally {
      onUploadEnd?.(type);
    }
  };

  const getDragText = (type: UploadType): string => {
    if (type === 'image') return 'Drag and drop image here';
    if (type === 'audio') return 'Drag and drop audio here';
    if (type === 'video') return 'Drag and drop video here';
    return 'Drag and drop file here';
  };

  const getClickText = (type: UploadType): string => {
    if (type === 'image') return 'Click to select image';
    if (type === 'audio') return 'Click to select audio';
    if (type === 'video') return 'Click to select video';
    return 'Click to select file';
  };

  const dragText = getDragText(uploadType);
  const clickText = getClickText(uploadType);

  const acceptMap: Record<UploadType, string> = {
    image: '.png,.jpg,.webp,.tiff',
    audio: '.mp3,.wav,.ogg',
    video: '.mp4,.webm,.mov',
    folder: '',
  };
  const accept = acceptMap[uploadType];

  return (
    <Upload
      dragger
      customRequest={customRequest}
      beforeUpload={beforeUpload}
      showUploadList={false}
      accept={accept}
      multiple={true}
      className='rounded'
    >
      <div className='mb-[10px] flex justify-center'>
        <Icon name='videoEditor-upload-icon' width={32} height={32} color='#9CA3AF' />
      </div>
      <div className='mb-[5px] text-[12px]'>{dragText}</div>
      <div className='text-[12px] text-[#71717a]'>{clickText}</div>
    </Upload>
  );
};

export default memo(MediaUploader);
