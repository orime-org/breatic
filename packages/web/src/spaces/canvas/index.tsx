/**
 * ProjectCanvas — public entry for one canvas Space inside a project.
 *
 * Thin shell: provides the ReactFlow context to its subtree, mounts
 * `ProjectCanvasContent` (the actual canvas surface), and the toast
 * stack. All canvas behavior lives in `view/ProjectCanvasContent.tsx`
 * and `view/canvas-helpers.ts`.
 *
 * Why this is so small:
 *   - PR-Y1 split the original 925-line shell into a thin entry +
 *     a content component + helpers, so the file you actually want
 *     to read for canvas behavior is `view/ProjectCanvasContent.tsx`
 *     (not this one).
 *   - Future hook decomposition (useAgentCanvasPickMode /
 *     useConnectEndMenu / useNodeDragGroup / useCanvasCommentMode)
 *     is a separate refactor; this entry doesn't change.
 */

import { ReactFlowProvider } from '@xyflow/react';
import { CanvasToastStack } from '@/spaces/canvas/view/CanvasToastStack';
import ProjectCanvasContent from '@/spaces/canvas/view/ProjectCanvasContent';
import { type UseProjectSpacesResult } from '@/domain/space/useProjectSpaces';

type ProjectCanvasProps = {
  yjs: UseProjectSpacesResult;
  hotkeysDisabled?: boolean;
};

const ProjectCanvas: React.FC<ProjectCanvasProps> = ({ yjs, hotkeysDisabled }) => (
  <ReactFlowProvider>
    <ProjectCanvasContent yjs={yjs} hotkeysDisabled={hotkeysDisabled} />
    <CanvasToastStack />
  </ReactFlowProvider>
);

export default ProjectCanvas;
