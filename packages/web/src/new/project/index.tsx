import '@xyflow/react/dist/style.css';
import { ReactFlowProvider } from '@xyflow/react';
import ProjectCanvas from './components/canvas/ProjectCanvas';

/**
 * Local canvas shell under `components/canvas` (no Yjs).
 */
export default function LocalProjectPage() {
  return (
    <div className='h-screen w-screen bg-background-default-secondary'>
      <ReactFlowProvider>
        <ProjectCanvas />
      </ReactFlowProvider>
    </div>
  );
}