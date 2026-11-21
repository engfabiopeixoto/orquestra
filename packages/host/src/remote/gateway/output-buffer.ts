import type { Logger } from '@orquestra/core';
import type { ClientConn, OutputBufferController, QueuedOutputEvent, SendWs } from './types.js';

export type OutputBufferOptions = {
  outputFlushMs: number;
  outputBufferLimit: number;
  sendWs: SendWs;
  log: Logger;
};

/** Cria o controlador de loteamento e limite do buffer de saída por conexão WebSocket. */
export function createOutputBuffer(opts: OutputBufferOptions): OutputBufferController {
  function clearOutput(conn: ClientConn): void {
    if (conn.outputTimer) clearTimeout(conn.outputTimer);
    conn.outputTimer = null;
    conn.output.clear();
    conn.outputBytes = 0;
  }

  function recomputeOutputBytes(conn: ClientConn): void {
    let total = 0;
    for (const entry of conn.output.values()) {
      total += entry.data.length;
    }
    conn.outputBytes = total;
    if (conn.output.size === 0 && conn.outputTimer) {
      clearTimeout(conn.outputTimer);
      conn.outputTimer = null;
    }
  }

  function flushOutput(conn: ClientConn): void {
    if (conn.outputTimer) clearTimeout(conn.outputTimer);
    conn.outputTimer = null;
    const entries = [...conn.output.values()];
    conn.output.clear();
    conn.outputBytes = 0;
    if (!conn.device) return;
    for (const entry of entries) {
      opts.sendWs(conn.ws, {
        type: 'event',
        event: {
          type: 'terminal.output',
          name: entry.name,
          data: entry.data,
          workspaceId: entry.workspaceId,
          sequence: entry.sequence,
        },
      });
    }
  }

  /** Agrupa a saída por conexão; passou do limite, descarta tudo e avisa para pedir snapshot novo. */
  function queueOutput(conn: ClientConn, event: QueuedOutputEvent): void {
    if (conn.overflowed.has(event.name)) return;
    const key = `${event.workspaceId ?? ''}:${event.name}`;
    const current = conn.output.get(key);
    conn.output.set(key, {
      name: event.name,
      workspaceId: event.workspaceId,
      data: (current?.data ?? '') + event.data,
      sequence: event.sequence,
    });
    conn.outputBytes += event.data.length;
    if (conn.outputBytes > opts.outputBufferLimit) {
      const dropped = [...conn.output.values()];
      clearOutput(conn);
      for (const entry of dropped) {
        conn.overflowed.add(entry.name);
        opts.sendWs(conn.ws, { type: 'output-overflow', name: entry.name, workspaceId: entry.workspaceId });
      }
      opts.log.warn({ deviceId: conn.device?.id }, 'saída remota descartada por excesso de buffer');
      return;
    }
    if (!conn.outputTimer) conn.outputTimer = setTimeout(() => flushOutput(conn), opts.outputFlushMs);
  }

  return { clearOutput, recomputeOutputBytes, flushOutput, queueOutput };
}
