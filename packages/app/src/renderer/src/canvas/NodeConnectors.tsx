import { Handle, Position } from '@xyflow/react';

export function NodeConnectors() {
  return <>
    <Handle type="source" position={Position.Left} id="left" />
    <Handle type="source" position={Position.Right} id="right" />
    <Handle type="source" position={Position.Top} id="top" />
    <Handle type="source" position={Position.Bottom} id="bottom" />
  </>;
}
