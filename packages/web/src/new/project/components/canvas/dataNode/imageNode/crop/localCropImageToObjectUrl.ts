/**
 * Crops a raster image to a rectangle in **source pixel** coordinates and returns a PNG object URL.
 * Used by the local canvas after {@link CropModal} confirms crop bounds.
 *
 * @param imageUrl - Same URL passed to the image element (blob: or http(s):).
 * @param crop - Top-left and size in original image pixels (matches CropModal `onApply` payload).
 * @returns New `blob:` URL for the cropped bitmap.
 * @throws When the image cannot be decoded or `canvas.toBlob` fails.
 */
export function localCropImageToObjectUrl(
  imageUrl: string,
  crop: { x: number; y: number; width: number; height: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const sx = Math.max(0, Math.round(crop.x));
      const sy = Math.max(0, Math.round(crop.y));
      const sw = Math.max(1, Math.min(Math.round(crop.width), img.naturalWidth - sx));
      const sh = Math.max(1, Math.min(Math.round(crop.height), img.naturalHeight - sy));

      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas 2D context unavailable'));
        return;
      }
      try {
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      } catch (e) {
        reject(e instanceof Error ? e : new Error('drawImage failed (possible CORS taint)'));
        return;
      }
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('toBlob returned null'));
            return;
          }
          resolve(URL.createObjectURL(blob));
        },
        'image/png',
        1,
      );
    };
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = imageUrl;
  });
}
