import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { RiUpload2Line, RiLinkM } from 'react-icons/ri';
import Upload from '@/components/base/upload';
import { cn } from '@/utils/classnames';

/* ─── Event bridge ────────────────────────────────────────────────── */

type ResolveFn = (src: string | null) => void;
let _pending: ResolveFn | null = null;

/**
 * Called from the SlashCommand image item.
 * The dialog will call `resolve` with the chosen src, or `null` on cancel.
 */
export const openImageDialog = (resolve: ResolveFn): void => {
  _pending = resolve;
  window.dispatchEvent(new CustomEvent('breatic:open-image-dialog'));
};

/* ─── Component ───────────────────────────────────────────────────── */

type Tab = 'upload' | 'url';

const ImageInsertDialog = () => {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('upload');
  const [url, setUrl] = useState('');

  useEffect(() => {
    const show = () => {
      setOpen(true);
      setTab('upload');
      setUrl('');
    };
    window.addEventListener('breatic:open-image-dialog', show);
    return () => window.removeEventListener('breatic:open-image-dialog', show);
  }, []);

  const cancel = () => {
    _pending?.(null);
    _pending = null;
    setOpen(false);
  };

  const confirm = (src: string) => {
    _pending?.(src);
    _pending = null;
    setOpen(false);
  };

  const handleUrlSubmit = () => {
    const trimmed = url.trim();
    if (trimmed) confirm(trimmed);
  };

  if (!open) return null;

  return createPortal(
    <div
      className='fixed inset-0 z-[95] flex items-center justify-center bg-black/40'
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div className='w-[440px] overflow-hidden rounded-[2px] border border-border-default-base bg-background-default-base shadow-[0_16px_48px_var(--color-shadow-overlay)]'>
        {/* Header */}
        <div className='px-5 pt-5 pb-3'>
          <h3 className='text-[14px] font-semibold text-text-default-base'>Insert Image</h3>
        </div>

        {/* Tabs */}
        <div className='flex border-b border-border-default-base px-5'>
          {(['upload', 'url'] as const).map((t) => (
            <button
              key={t}
              type='button'
              onClick={() => setTab(t)}
              className={cn(
                'mr-5 -mb-px border-b-2 pb-2.5 text-[13px] font-medium transition-colors',
                tab === t
                  ? 'border-brand-base text-brand-base'
                  : 'border-transparent text-text-default-tertiary hover:text-text-default-base',
              )}
            >
              {t === 'upload' ? 'Upload' : 'Embed URL'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className='p-5'>
          {tab === 'upload' ? (
            <Upload
              dragger
              accept='image/*'
              multiple={false}
              showUploadList={false}
              className='w-full rounded-[2px]'
              beforeUpload={(file, fileList) => {
                if (!file.type.startsWith('image/')) return false;
                if (fileList[0] !== file) return false;
                const reader = new FileReader();
                reader.onload = (e) => {
                  const result = e.target?.result;
                  if (typeof result === 'string') confirm(result);
                };
                reader.readAsDataURL(file);
                return false;
              }}
            >
              <div className='flex flex-col items-center justify-center gap-3'>
                <RiUpload2Line size={24} className='text-text-default-tertiary' />
                <div>
                  <p className='text-[13px] text-text-default-base'>Drop image here or click to browse</p>
                  <p className='mt-0.5 text-center text-[12px] text-text-default-tertiary'>PNG, JPG, GIF, WebP</p>
                </div>
              </div>
            </Upload>
          ) : (
            <div className='flex flex-col gap-3'>
              <div className='flex items-center gap-2 rounded-[2px] border border-border-default-base bg-background-default-secondary px-3 py-2'>
                <RiLinkM size={15} className='shrink-0 text-text-default-tertiary' />
                <input
                  type='url'
                  placeholder='https://example.com/image.jpg'
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleUrlSubmit();
                    if (e.key === 'Escape') cancel();
                  }}
                  className='flex-1 bg-transparent text-[13px] text-text-default-base placeholder:text-text-default-tertiary outline-none'
                  autoFocus
                />
              </div>
              <button
                type='button'
                disabled={!url.trim()}
                onClick={handleUrlSubmit}
                className='w-full rounded-[2px] bg-brand-base py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40'
              >
                Embed Image
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className='flex justify-end border-t border-border-default-base px-5 py-3'>
          <button
            type='button'
            onClick={cancel}
            className='rounded-[2px] px-3 py-1.5 text-[13px] text-text-default-tertiary transition-colors hover:bg-background-default-secondary'
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default ImageInsertDialog;
