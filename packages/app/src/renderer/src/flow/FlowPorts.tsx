import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect } from 'react';
import type { FlowNode } from '@orquestra/shared/flow';
import { useFlowUI } from './ui-context';

export function FlowPorts({ node, canvasId }: { node: FlowNode; canvasId: string }) {
  const ui = useFlowUI();
  const update = useUpdateNodeInternals();
  useEffect(() => { update(canvasId); }, [canvasId, node.inputs, node.outputs, update]);
  const rows = Math.max(node.inputs.length, node.outputs.length);
  return <div className="data-ports nodrag nopan" aria-label="Entradas e saídas">
    <div className="data-port-headings"><span>ENTRADAS</span><span>SAÍDAS</span></div>
    {Array.from({ length: rows }, (_, index) => <div className="data-port-row" key={index}>
      <div className="data-port input">{node.inputs[index] ? <><Handle type="target" position={Position.Left} id={`in:${node.inputs[index]!.name}`} /><button title={`${node.inputs[index]!.type}${node.inputs[index]!.unit ? ` · ${node.inputs[index]!.unit}` : ''} · limite ${node.inputs[index]!.maxBytes} bytes`} onClick={() => ui.inspect({ nodeId: node.id, port: node.inputs[index]!.name, direction: 'input' })}>{node.inputs[index]!.label || node.inputs[index]!.name}<small>{node.inputs[index]!.type}</small></button></> : null}</div>
      <div className="data-port output">{node.outputs[index] ? <><button title={`${node.outputs[index]!.type} · limite ${node.outputs[index]!.maxBytes} bytes`} onClick={() => ui.inspect({ nodeId: node.id, port: node.outputs[index]!.name, direction: 'output' })}>{node.outputs[index]!.label || node.outputs[index]!.name}<small>{node.outputs[index]!.type}</small></button><Handle type="source" position={Position.Right} id={`out:${node.outputs[index]!.name}`} /></> : null}</div>
    </div>)}
  </div>;
}
