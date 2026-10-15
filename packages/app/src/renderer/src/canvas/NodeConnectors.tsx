import { Handle, Position } from '@xyflow/react';

export function NodeConnectors() {
  return <>
    <Handle type="source" position={Position.Left} id="left" className="node-connector" />
    <Handle type="source" position={Position.Right} id="right" className="node-connector" />
    <Handle type="source" position={Position.Top} id="top" className="node-connector" />
    <Handle type="source" position={Position.Bottom} id="bottom" className="node-connector" />
  </>;
}
