/**
 * Toast notification stack for AIGC generation completion.
 *
 * Displays in the bottom-right corner of the canvas. Each toast
 * auto-dismisses after 5 seconds. Clicking navigates to the node.
 */

import { useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useCanvasData } from '@/contexts/CanvasDataContext';
import { useCanvasUI } from '@/hooks/useCanvasUI';
import { useTranslation } from 'react-i18next';

export function CanvasToastStack() {
  const { toasts, dismissToast } = useCanvasData();
  const { openRightPanel } = useCanvasUI();
  const reactFlow = useReactFlow();
  const { t } = useTranslation();

  const handleClick = useCallback(
    (nodeId: string) => {
      // Center on node if it still exists
      const node = reactFlow.getNode(nodeId);
      if (node) {
        reactFlow.setCenter(
          node.position.x + (node.measured?.width ?? 200) / 2,
          node.position.y + (node.measured?.height ?? 100) / 2,
          { duration: 300 },
        );
      }
      // Open history panel for this node
      openRightPanel('history', nodeId);
    },
    [reactFlow, openRightPanel],
  );

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-auto" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => {
            handleClick(toast.nodeId);
            dismissToast(toast.id);
          }}
          className={`flex items-center gap-2 rounded-lg px-4 py-2.5 shadow-lg text-sm font-medium text-white transition-all animate-in slide-in-from-right-5 ${
            toast.type === 'completed'
              ? 'bg-green-500 hover:bg-green-600'
              : 'bg-red-500 hover:bg-red-600'
          }`}
        >
          <span className="flex-shrink-0">
            {toast.type === 'completed' ? '✓' : '✕'}
          </span>
          <span className="truncate max-w-[200px]">
            {toast.nodeName || t('project.canvas.node', 'Node')}
          </span>
          <span className="text-white/80">
            {toast.type === 'completed'
              ? t('project.canvas.generationComplete', 'Generation complete')
              : t('project.canvas.generationFailed', 'Generation failed')}
          </span>
        </button>
      ))}
    </div>
  );
}
