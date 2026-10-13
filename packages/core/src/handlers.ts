import { OrqError, type MethodName, type Params, type Result } from '@orquestra/shared';
import type { AskBroker } from './ask-broker.js';
import type { Note, NoteStore } from './notes.js';
import type { Caller, Dispatch } from './pipe-server.js';
import type { Session } from './session.js';
import type { Topology } from './topology.js';
import type { BrowserHandler, BrowserNode, BrowserMethod } from '@orquestra/shared';

const REGENT_METHODS = [
  'regent.new',
  'regent.remove',
  'regent.link',
  'regent.unlink',
  'regent.brief',
  'persona.list',
  'persona.show',
  'persona.write',
  'persona.remove',
] as const;
export type RegentMethod = (typeof REGENT_METHODS)[number];
export type RegentHandler = <M extends RegentMethod>(method: M, params: Params<M>, caller: string) => Promise<Result<M>>;

export type HandlerDeps = {
  topology: Topology;
  notes: NoteStore;
  broker: AskBroker;
  session: (name: string) => Session | undefined;
  onNoteChanged: (note: Note, createdBy: string | null) => void;
  isRegent: (name: string) => boolean;
  regent?: RegentHandler;
  browser?: BrowserHandler;
  browserNodes?: () => BrowserNode[];
};

type Handlers = { [M in MethodName]: (params: Params<M>, caller: Caller, signal: AbortSignal) => Promise<Result<M>> };

export function createHandlers(deps: HandlerDeps): Dispatch {
  const requireSession = (name: string): Session => {
    const session = deps.session(name);
    if (!session) throw new OrqError('NOT_FOUND', `Terminal ${name} não existe. Veja os conectados com orq peers.`);
    return session;
  };

  const requireConnected = (from: string, to: string, kind: 'terminal' | 'note' | 'portal'): void => {
    if (deps.topology.kindOf(to) !== kind) {
      const what = kind === 'terminal' ? 'Terminal' : kind === 'portal' ? 'Navegador' : 'Nota';
      const hint = kind === 'terminal' ? 'orq peers' : kind === 'portal' ? 'orq portal list' : 'orq note list';
      throw new OrqError('NOT_FOUND', `${what} ${to} não existe. Veja o que está conectado com ${hint}.`);
    }
    if (!deps.topology.isConnected(from, to)) {
      throw new OrqError('NOT_CONNECTED', `${to} não está conectado a você. Conecte os dois no canvas.`);
    }
  };

  const regentCommand =
    <M extends RegentMethod>(method: M) =>
    async (params: Params<M>, caller: Caller): Promise<Result<M>> => {
      if (!deps.isRegent(caller.session)) {
        throw new OrqError('NOT_REGENT', `${caller.session} não é regente. Marque a opção "Regente" no terminal para usar este comando.`);
      }
      if (!deps.regent) throw new OrqError('UNSUPPORTED', 'Os comandos de regente precisam do app do Orquestra.');
      return deps.regent(method, params, caller.session);
    };

  function browserCommand<M extends BrowserMethod>(method: M): Handlers[M] {
    return (async (params: Params<M>, caller: Caller, signal: AbortSignal) => {
      requireConnected(caller.session, params.id, 'portal');
      if (!deps.browser) throw new OrqError('APP_UNAVAILABLE', 'Abra o navegador no aplicativo Orquestra.');
      return deps.browser(method, params, signal);
    }) as Handlers[M];
  }

  const handlers: Handlers = {
    'portal.list': async (_params, caller) => ({ portals: (deps.browserNodes?.() ?? []).filter((portal) => deps.topology.isConnected(caller.session, portal.id)) }),
    'portal.check': browserCommand('portal.check'),
    'portal.navigate': browserCommand('portal.navigate'),
    'portal.click': browserCommand('portal.click'),
    'portal.type': browserCommand('portal.type'),
    'portal.scroll': browserCommand('portal.scroll'),
    'portal.screenshot': browserCommand('portal.screenshot'),
    whoami: async (_params, caller) => {
      const session = requireSession(caller.session);
      return { name: session.name, agent: session.adapter.kind };
    },
    peers: async (_params, caller) => ({
      peers: deps.topology.neighbors(caller.session, 'terminal').map((name) => {
        const session = requireSession(name);
        return { name, agent: session.adapter.kind, state: session.state, queued: deps.broker.queued(name) };
      }),
      ...(deps.topology.neighbors(caller.session, 'portal').length ? { portals: (deps.browserNodes?.() ?? []).filter((portal) => deps.topology.isConnected(caller.session, portal.id)) } : {}),
    }),
    prompt: async (params, caller, signal) => {
      if (params.target === caller.session) {
        throw new OrqError('USAGE', 'Não dá para enviar um prompt para você mesmo. Escolha outro destino.');
      }
      requireConnected(caller.session, params.target, 'terminal');
      if (!requireSession(params.target).adapter.acceptsPrompts) {
        throw new OrqError('UNSUPPORTED', `${params.target} é um shell e não recebe prompts. Use orq read para ler a tela.`);
      }
      return deps.broker.submit({ asker: caller.session, target: params.target, text: params.text, timeoutMs: params.timeoutMs, signal });
    },
    result: async (params) => {
      const status = deps.broker.status(params.askId);
      if (!status) throw new OrqError('NOT_FOUND', `Pedido ${params.askId} não encontrado. Confira o id impresso pelo orq prompt.`);
      if (status.status === 'answered') return { status: 'answered', answer: status.answer };
      if (status.status === 'failed') return { status: 'failed', reason: status.reason };
      return { status: 'pending' };
    },
    read: async (params, caller) => {
      requireConnected(caller.session, params.target, 'terminal');
      return { text: requireSession(params.target).screenText(params.lines) };
    },
    'note.list': async (_params, caller) => ({
      notes: deps.topology.neighbors(caller.session, 'note').map((name) => ({ name, revision: deps.notes.get(name)?.revision ?? 0 })),
    }),
    'note.show': async (params, caller) => {
      requireConnected(caller.session, params.name, 'note');
      const note = deps.notes.get(params.name)!;
      return { name: note.name, content: note.content, revision: note.revision };
    },
    'note.write': async (params, caller) => {
      if (deps.topology.kindOf(params.name) === undefined) {
        // Nota nova nasce conectada ao autor.
        deps.topology.add(params.name, 'note');
        deps.topology.connect(caller.session, params.name);
      } else {
        requireConnected(caller.session, params.name, 'note');
      }
      const { revision, created } = deps.notes.write(params.name, params.content, caller.session);
      deps.onNoteChanged(deps.notes.get(params.name)!, created ? caller.session : null);
      return { name: params.name, revision, created };
    },
    'note.append': async (params, caller) => {
      requireConnected(caller.session, params.name, 'note');
      const { revision } = deps.notes.append(params.name, params.content, caller.session);
      deps.onNoteChanged(deps.notes.get(params.name)!, null);
      return { name: params.name, revision };
    },
    hook: async (params, caller) => {
      await requireSession(caller.session).handleHook(params.event, params.payload, params.agent);
      return {};
    },
    'regent.new': regentCommand('regent.new'),
    'regent.remove': regentCommand('regent.remove'),
    'regent.link': regentCommand('regent.link'),
    'regent.unlink': regentCommand('regent.unlink'),
    'regent.brief': regentCommand('regent.brief'),
    'persona.list': regentCommand('persona.list'),
    'persona.show': regentCommand('persona.show'),
    'persona.write': regentCommand('persona.write'),
    'persona.remove': regentCommand('persona.remove'),
  };

  return (method, params, caller, signal) =>
    (handlers[method] as (p: unknown, c: Caller, s: AbortSignal) => Promise<unknown>)(params, caller, signal);
}
