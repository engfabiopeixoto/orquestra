import { createContext, useContext } from 'react';
export type FlowInspection = { nodeId: string; port: string; direction: 'input' | 'output'; runId?: string };
export type FlowUI = { library(): void; edit(id: string): void; inspect(input: FlowInspection): void; history(): void; tests(id: string): void };
export const FlowUIContext = createContext<FlowUI | null>(null);
export function useFlowUI(): FlowUI { const ui = useContext(FlowUIContext); if (!ui) throw new Error('Controles de fluxo indisponíveis.'); return ui; }
