/**
 * `features/upload` — single canonical upload entry point used by
 * `LeftFloatingMenu`'s upload button, `ClipboardPasteHandler`, and
 * `AudioNode`'s record-end handler.
 *
 * Pre-F5, every asset node had its own `customRequest` that wrote
 * `URL.createObjectURL(file)` into Yjs `data.content` — handy for
 * a demo, fatal in production: blob URLs die with the page reload,
 * collaborators get broken `<img>` / `<video>` tags. F5 routes every
 * upload through `useUploadFiles` so the URL written to Yjs is
 * always a permanent S3/OSS/local URL.
 */
export { useUploadFiles, uploadOne, NODE_TYPE_BY_KIND } from './use-upload-files';
export type { UploadedFile, UploadedFileMeta } from './use-upload-files';
