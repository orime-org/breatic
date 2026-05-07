import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

/** Target handle for temp anchor when dragging from a source handle. */
export const connectEndAnchorTargetHandleId = 'ConnectEnd_0_0';
/** Source handle for temp anchor when dragging from a target handle. */
export const connectEndAnchorSourceHandleId = 'ConnectEnd_0_1';

/** @deprecated Use `connectEndAnchorTargetHandleId`. */
export const connectEndAnchorHandleId = connectEndAnchorTargetHandleId;

const ConnectEndAnchorNode: React.FC<NodeProps> = () => (
  <div
    className='pointer-events-none absolute'
    style={{ width: 1, height: 1, minWidth: 1, minHeight: 1, overflow: 'hidden' }}
  >
    <Handle
      type='target'
      position={Position.Left}
      id={connectEndAnchorTargetHandleId}
      className='!h-1 !w-1 !min-h-1 !min-w-1 !border-0 !opacity-0'
      style={{ left: 0, top: 0 }}
    />
    <Handle
      type='source'
      position={Position.Right}
      id={connectEndAnchorSourceHandleId}
      className='!h-1 !w-1 !min-h-1 !min-w-1 !border-0 !opacity-0'
      style={{ right: 0, top: 0 }}
    />
  </div>
);

export default ConnectEndAnchorNode;
