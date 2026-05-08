/**
 * ProjectCanvasViewportRegistrar — registers the canvas viewport API
 * (centerOnFlowPos / setNodes etc.) globally so the image editor
 * sibling panel can pan/zoom the project canvas without prop-drilling
 * through the entire `apps/project` tree.
 *
 * Lives inside `ReactFlowProvider` (so `useReactFlow` works), runs an
 * effect on mount that publishes the API via `setProjectCanvasViewportApi`,
 * and clears it on unmount. Renders nothing.
 */

import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import {
  type ProjectCanvasViewportApi,
  setProjectCanvasViewportApi,
  getProjectCanvasPaneClientCenter,
} from '@/spaces/canvas/types';

const ProjectCanvasViewportRegistrar: React.FC = () => {
  const { screenToFlowPosition, setCenter, getZoom, getNodes, setNodes } = useReactFlow();
  useEffect(() => {
    const api: ProjectCanvasViewportApi = {
      centerOnFlowPos: (flowX, flowY, opts) => {
        const zoom = getZoom();
        setCenter(flowX, flowY, { zoom, duration: opts?.smooth ? 320 : 0 });
      },
      flowPosFromPaneCenter: () => {
        const center = getProjectCanvasPaneClientCenter();
        if (!center) return null;
        return screenToFlowPosition(center);
      },
      setNodes: (updater) => {
        setNodes(updater(getNodes()));
      },
    };
    setProjectCanvasViewportApi(api);
    return () => setProjectCanvasViewportApi(null);
  }, [screenToFlowPosition, setCenter, getZoom, getNodes, setNodes]);
  return null;
};

export default ProjectCanvasViewportRegistrar;
