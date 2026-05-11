/**
 * ProjectCanvasViewportRegistrar — publishes the canvas viewport API to a
 * module-level registry so siblings that live outside `<ReactFlowProvider>`
 * (e.g. `ChatPanel` mounted at the page level, the document space's
 * `RightToolbar`) can pan/zoom the canvas without prop-drilling and without
 * being inside the provider subtree themselves.
 *
 * Renders nothing. Must be mounted inside `<ReactFlowProvider>` — that's the
 * whole reason this component exists: it's the one place that's allowed to
 * call `useReactFlow`, and it relays the viewport handles outward.
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
      getViewportCenterFlow: () => {
        const c = getProjectCanvasPaneClientCenter();
        if (!c) return null;
        return screenToFlowPosition(c);
      },
      centerOnFirstNodeId: (nodeIds, select) => {
        const nodes = getNodes();
        const target = nodes.find((n) => nodeIds.includes(n.id));
        if (!target) return;
        if (select) {
          setNodes(nodes.map((n) => ({ ...n, selected: n.id === target.id })));
        }
        setCenter(target.position.x, target.position.y, {
          zoom: getZoom(),
          duration: 320,
        });
      },
    };
    setProjectCanvasViewportApi(api);
    return () => setProjectCanvasViewportApi(null);
  }, [screenToFlowPosition, setCenter, getZoom, getNodes, setNodes]);
  return null;
};

export default ProjectCanvasViewportRegistrar;
