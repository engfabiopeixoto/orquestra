import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type { Logger } from '@orquestra/core';
import type {
  HostToMain,
  RemoteDevice,
  RemoteServerMessage,
  RemoteTailscaleStatus,
} from '@orquestra/shared';
import type { TailscaleController } from '../tailscale.js';

export type RemoteGatewayOptions = {
  dataDir: string;
  log: Logger;
  electronSend: (message: HostToMain) => void;
  port?: number;
  host?: string;
  mobileDir?: string;
  authTimeoutMs?: number;
  pairTtlMs?: number;
  rateLimit?: number;
  rateWindowMs?: number;
  allowedOrigins?: string[];
  outputFlushMs?: number;
  outputBufferLimit?: number;
  persistEnabledState?: boolean;
  tailscale?: TailscaleController | false;
  fallbackBindHost?: string;
  now?: () => number;
};

export type ClientConn = {
  id: string;
  ws: WebSocket;
  device: RemoteDevice | null;
  authTimer: NodeJS.Timeout | null;
  subscriptions: Set<string>;
  /** Saída pendente por terminal, agrupada a cada REMOTE_OUTPUT_FLUSH_MS. */
  output: Map<string, { name: string; workspaceId?: string; data: string; sequence?: number }>;
  outputBytes: number;
  outputTimer: NodeJS.Timeout | null;
  /** Terminais cuja saída foi descartada por excesso: ficam mudos até o cliente pedir um snapshot novo. */
  overflowed: Set<string>;
};

export type PendingCommand = {
  connId: string;
  clientCmdId: string;
  method: string;
  terminal?: string;
};

export type QueuedOutputEvent = {
  name: string;
  data: string;
  workspaceId?: string;
  sequence?: number;
};

export type OriginContext = {
  host: string;
  activePort: () => number;
  tailscaleStatus: () => RemoteTailscaleStatus;
  extraAllowedOrigins: ReadonlySet<string>;
};

export type RequestUrlContext = {
  host: string;
  activePort: () => number;
};

export type OriginCheck = (origin: string | undefined) => boolean;
export type RequestUrlParser = (req: IncomingMessage) => URL | null;
export type SendWs = (ws: WebSocket, message: RemoteServerMessage) => void;

export type OutputBufferController = {
  clearOutput: (conn: ClientConn) => void;
  recomputeOutputBytes: (conn: ClientConn) => void;
  flushOutput: (conn: ClientConn) => void;
  queueOutput: (conn: ClientConn, event: QueuedOutputEvent) => void;
};
