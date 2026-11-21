import type {
  AgentAdapter,
  Logger,
  ModelCatalogStore,
  ModelCatalogStoreDeps,
  Note,
  Orquestra,
  PersonaStore,
  PtyHost,
  RecentProjects,
  Session,
  SettingsStore,
  WorkspaceSaver,
} from '@orquestra/core';
import type {
  GroupElement,
  GroupLayout,
  HostAgent,
  HostMethod,
  HostParams,
  HostResult,
  HostToMain,
  MainToHost,
  MethodName,
  NoteInfo,
  Persona,
  ProjectSnapshot,
  SubscriptionUsage,
  TerminalInfo,
  Workspace,
} from '@orquestra/shared';
import type { OutputBatcher } from '../output-batcher.js';
import type { Rect } from '../placement.js';
import type { WorkspaceState } from '../workspace-state.js';

export type UsageState = {
  cache: Map<string, { expiresAt: number; value: SubscriptionUsage }>;
  pending: Map<string, Promise<SubscriptionUsage>>;
  failures: Map<string, { retryAt: number; message: string }>;
};

export type HostBridgeOptions = {
  send: (message: HostToMain) => void;
  adapters: Record<string, AgentAdapter>;
  cliScript: string;
  pipePath: string;
  dataDir: string;
  log: Logger;
  ptyHost?: PtyHost;
  readyQuietMs?: number;
  agyHooksFile?: string;
  outputIntervalMs?: number;
  /** Onde gravar os PIDs dos agentes vivos (AGENT_PID_FILE na pasta de dados). */
  agentPidFile?: string;
  onPids?: (pids: number[]) => void;
  usageState?: UsageState;
  eventSequence?: () => number;
  /** Lista de projetos recentes (recent.json na pasta de dados). */
  recentFile: string;
  /** Padrões dos agentes (settings.json na pasta de dados). */
  settingsFile: string;
  /** Funções globais dos agentes (personas.json na pasta de dados). */
  personasFile: string;
  /** Espera depois da última mudança antes de gravar o workspace (padrão 1 s). */
  saveDelayMs?: number;
  /** Pasta de configuração do Claude Code, onde ficam os jobs em segundo plano (padrão: CLAUDE_CONFIG_DIR ou ~/.claude). */
  claudeDir?: string;
  /** settings.json do agy, injetável nos testes. */
  agySettingsFile?: string;
  /** Catálogo de modelos compartilhado entre workspaces (criado aqui quando ausente). */
  modelCatalog?: ModelCatalogStore;
  /** Dependências injetáveis para descoberta de modelos nos testes. */
  modelCatalogDeps?: ModelCatalogStoreDeps;
  /** Lista os named pipes do sistema; o daemon abre um por conversa viva. Injetável nos testes. */
  listPipes?: () => string[];
  /** Intervalo da verificação dos jobs em segundo plano (padrão 5 s). */
  backgroundJobPollMs?: number;
  /** Leitores de uso das assinaturas injetáveis nos testes. */
  usageReaders?: Partial<Record<'claude' | 'codex' | 'agy', () => Promise<SubscriptionUsage>>>;
  /** Caminho do script usado pelo worker de qualidade (injetável nos testes). */
  qualityScript?: string;
};

export type HostBridge = {
  handle(message: Exclude<MainToHost, { kind: 'shutdown' }>): Promise<void>;
  /** Só para testes: chama os comandos do orq como se viessem do pipe. */
  dispatchForTest(method: MethodName, params: unknown, caller: { session: string }): Promise<unknown>;
  /** Cancela operações em segundo plano (ex.: medição de qualidade) antes de encerrar. */
  abortBackground?(): void;
  close(): Promise<void>;
};

export type OpenProject = { dir: string; name: string; state: WorkspaceState; saver: WorkspaceSaver };

export type BridgeMethod = Exclude<
  HostMethod,
  'workspace.list' | 'workspace.activate' | 'remote.status' | 'remote.enable' | 'remote.pair' | 'remote.devices' | 'remote.revoke'
>;

export type Handlers = { [M in BridgeMethod]: (params: HostParams<M>) => Promise<HostResult<M>> };

export type CreateTerminalInput = {
  id?: string;
  name: string;
  agent: HostAgent;
  cwd?: string;
  resume?: boolean;
  args?: string[];
  regente?: boolean;
  persona?: string;
  monitor?: boolean;
  model?: string | null;
};

export type RemovedTerminalTracker = {
  remember(project: OpenProject | null, name: string): void;
  peek(name: string): { rect: Rect; groupId: string | null } | null;
  forget(name: string): void;
  clear(): void;
};

export type BridgeContext = {
  opts: HostBridgeOptions;
  recent: RecentProjects;
  settings: SettingsStore;
  personaStore: PersonaStore;
  modelCatalog: ModelCatalogStore;
  batcher: OutputBatcher;
  removedTerminals: RemovedTerminalTracker;
  getOrquestra: () => Orquestra;
  getProject: () => OpenProject | null;
  setProject: (next: OpenProject | null) => void;
  requireProject: () => OpenProject;
  requireSession: (name: string) => Session;
  capture: (current: OpenProject) => Workspace;
  snapshot: (current: OpenProject) => ProjectSnapshot;
  changed: () => void;
  noteInfo: (note: Note) => NoteInfo;
  info: (session: Session) => TerminalInfo;
  recordPids: () => void;
  resolvePersona: (name: string) => Persona;
  createTerminalFor: (input: CreateTerminalInput) => Promise<Session>;
  groupElements: () => GroupElement[];
  groupLayout: () => GroupLayout;
  emitGroupLayout: () => GroupLayout;
  prepareGroupedNode: (groupId: string, kind: 'terminal' | 'note', name: string) => { id: string; rect: Rect };
  abortQuality: () => void;
};
