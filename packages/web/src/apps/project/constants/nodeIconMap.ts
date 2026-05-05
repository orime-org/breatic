/**
 * Maps node `template_type` IDs to `<Icon name="..." />` keys (`node-*`, kebab-case).
 * Unknown types are omitted; callers should fall back when needed.
 */
const nodeIconMap: Record<string, string> = {
  '1001': 'node-text-snippet',
  '1002': 'node-image',
  '1003': 'node-movie-filter',
  '1004': 'node-music-note',
  '6001': 'node-movie-edit',
};

export default nodeIconMap;
