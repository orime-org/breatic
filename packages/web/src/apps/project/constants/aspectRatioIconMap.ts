/**
 * aspectRadioIconMap.ts
 * ------------------------------------------------------------
 * Responsibility:
 * - Maps aspect ratio + resolution combinations to UI icons
 *
 * Usage:
 * - Used by aspect ratio selectors in image/video generation panels
 * - Allows different resolutions to share the same visual representation
 *
 * Design notes:
 * - Keys are human-readable labels shown in the UI
 * - Icons can be replaced in the future without changing consumers
 */
const aspectRatioIconMap: Record<string, string> = {
  'auto': 'aspectRatio-crop-auto',
  '1:1': 'aspectRatio-crop-square',
  '2:3': 'aspectRatio-crop-2-3',
  '3:2': 'aspectRatio-crop-3-2',
  '3:4': 'aspectRatio-crop-3-4',
  '4:3': 'aspectRatio-crop-4-3',
  '4:5': 'aspectRatio-crop-4-5',
  '5:4': 'aspectRatio-crop-5-4',
  '9:16': 'aspectRatio-crop-9-16',
  '16:9': 'aspectRatio-crop-16-9',
  '21:9': 'aspectRatio-crop-21-9',
  '1:1(1k)': 'aspectRatio-crop-square',
  '1:1(2k)': 'aspectRatio-crop-square',
  '1:1(4k)': 'aspectRatio-crop-square',
  '2:3(1k)': 'aspectRatio-crop-2-3',
  '2:3(2k)': 'aspectRatio-crop-2-3',
  '2:3(4k)': 'aspectRatio-crop-2-3',
  '3:2(1k)': 'aspectRatio-crop-3-2',
  '3:2(2k)': 'aspectRatio-crop-3-2',
  '3:2(4k)': 'aspectRatio-crop-3-2',
  '3:4(1k)': 'aspectRatio-crop-3-4',
  '3:4(2k)': 'aspectRatio-crop-3-4',
  '3:4(4k)': 'aspectRatio-crop-3-4',
  '4:3(1k)': 'aspectRatio-crop-4-3',
  '4:3(2k)': 'aspectRatio-crop-4-3',
  '4:3(4k)': 'aspectRatio-crop-4-3',
  '4:5(1k)': 'aspectRatio-crop-4-5',
  '4:5(2k)': 'aspectRatio-crop-4-5',
  '4:5(4k)': 'aspectRatio-crop-4-5',
  '5:4(1k)': 'aspectRatio-crop-5-4',
  '5:4(2k)': 'aspectRatio-crop-5-4',
  '5:4(4k)': 'aspectRatio-crop-5-4',
  '9:16(1k)': 'aspectRatio-crop-9-16',
  '9:16(2k)': 'aspectRatio-crop-9-16',
  '9:16(4k)': 'aspectRatio-crop-9-16',
  '16:9(1k)': 'aspectRatio-crop-16-9',
  '16:9(2k)': 'aspectRatio-crop-16-9',
  '16:9(4k)': 'aspectRatio-crop-16-9',
  '21:9(1k)': 'aspectRatio-crop-21-9',
  '21:9(2k)': 'aspectRatio-crop-21-9',
  '21:9(4k)': 'aspectRatio-crop-21-9',
  '9:16(480p)': 'aspectRatio-crop-9-16',
  '16:9(480p)': 'aspectRatio-crop-16-9',
  '9:16(720p)': 'aspectRatio-crop-9-16',
  '16:9(720p)': 'aspectRatio-crop-16-9',
  '9:16(1080p)': 'aspectRatio-crop-9-16',
  '16:9(1080p)': 'aspectRatio-crop-16-9',
};

export default aspectRatioIconMap;
