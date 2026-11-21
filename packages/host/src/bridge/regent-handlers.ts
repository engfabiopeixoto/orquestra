import type { RegentHandler, RegentMethod } from '@orquestra/core';
import { isReadySessionState, OrqError, personaBrief, type Params, type PersonaScope, type Result } from '@orquestra/shared';
import { overlaps, placeBeside, TERMINAL_SIZE } from '../placement.js';
import type { BridgeContext } from './context.js';

type RegentHandlers = { [M in RegentMethod]: (params: Params<M>, caller: string) => Promise<Result<M>> };

const STATE_LABELS = {
  starting: 'iniciando',
  idle: 'ocioso',
  background: 'em segundo plano',
  busy: 'ocupado',
  waiting: 'aguardando',
  exited: 'encerrado',
} as const;

/** Cria o manipulador dos comandos `regent.*` e `persona.*` vindos do pipe de agentes regentes. */
export function createRegentHandler(ctx: BridgeContext): RegentHandler {
  const regentHandlers: RegentHandlers = {
    'regent.new': async (params, caller) => {
      const current = ctx.requireProject();
      const orquestra = ctx.getOrquestra();
      if (params.agent === 'shell' && params.persona) {
        throw new OrqError('USAGE', 'O shell não recebe funções.');
      }
      const resolvedPersona = params.persona ? ctx.resolvePersona(params.persona) : undefined;
      const remembered = ctx.removedTerminals.peek(params.name);
      const existingRects = Object.values(current.state.layout());
      const canReuseRect = Boolean(remembered && !existingRects.some((other) => overlaps(remembered.rect, other)));
      const authorRect = current.state.rectOf(caller) ?? { x: 80, y: 80, ...TERMINAL_SIZE };
      const rect = canReuseRect
        ? { ...remembered!.rect }
        : { ...placeBeside(authorRect, existingRects, TERMINAL_SIZE), ...TERMINAL_SIZE };
      const session = await ctx.createTerminalFor({
        name: params.name,
        agent: params.agent,
        cwd: params.cwd,
        resume: params.resume,
        // Sem --args, vale o mesmo que a janela de novo terminal: os padrões dos agentes.
        args: params.args ?? (params.agent === 'shell' ? [] : ctx.settings.get().defaultArgs[params.agent]),
        regente: false,
        persona: params.persona,
      });
      ctx.removedTerminals.forget(params.name);
      current.state.place(params.name, rect);
      orquestra.connect(caller, params.name);
      if (resolvedPersona) {
        orquestra.brief(session.name, caller, personaBrief(resolvedPersona, { regent: false }));
      }
      ctx.opts.send({
        kind: 'event',
        event: {
          type: 'terminal.added',
          info: ctx.info(session),
          rect,
          connectedTo: caller,
        },
      });
      if (remembered?.groupId && current.state.grouping.list().some((group) => group.id === remembered.groupId)) {
        try {
          current.state.grouping.assign(remembered.groupId, [{ kind: 'terminal', id: session.id }], ctx.groupElements());
          ctx.emitGroupLayout();
        } catch {
          // Se o grupo estiver bloqueado e não comportar o nó, mantém o terminal fora dele.
        }
      }
      ctx.opts.send({ kind: 'event', event: { type: 'notice', level: 'info', message: `${caller} criou ${params.name}.` } });
      return { name: session.name };
    },

    'regent.remove': async (params, caller) => {
      const orquestra = ctx.getOrquestra();
      if (caller === params.name) {
        throw new OrqError('USAGE', 'Um regente não pode remover a si mesmo. Peça ao usuário ou use a interface.');
      }
      const kind = orquestra.topology.kindOf(params.name);
      if (!kind) throw new OrqError('NOT_FOUND', `Terminal ou nota ${params.name} não existe.`);
      if (kind === 'terminal') {
        await orquestra.removeTerminal(params.name, { reason: `removido por ${caller}` });
      } else {
        orquestra.removeNote(params.name);
        ctx.getProject()?.state.forget(params.name);
        ctx.changed();
        ctx.opts.send({ kind: 'event', event: { type: 'note.removed', name: params.name } });
      }
      ctx.opts.send({ kind: 'event', event: { type: 'notice', level: 'info', message: `${caller} removeu ${params.name}.` } });
      return {};
    },

    'regent.restart': async (params, caller) => {
      const orquestra = ctx.getOrquestra();
      if (caller === params.name) {
        throw new OrqError('USAGE', 'Um regente não pode reiniciar a si mesmo. Peça ao usuário ou use a interface.');
      }
      const kind = orquestra.topology.kindOf(params.name);
      if (!kind) throw new OrqError('NOT_FOUND', `Terminal ${params.name} não existe.`);
      if (kind !== 'terminal') throw new OrqError('USAGE', 'Só terminais podem ser reiniciados.');

      const session = await orquestra.restartTerminal(params.name, { reason: `${params.name} foi reiniciado por ${caller}` });
      const terminalInfo = ctx.info(session);
      ctx.opts.send({ kind: 'event', event: { type: 'terminal.replaced', info: terminalInfo } });
      ctx.opts.send({ kind: 'event', event: { type: 'notice', level: 'info', message: `${caller} reiniciou ${params.name}.` } });
      ctx.recordPids();
      ctx.changed();
      return { name: session.name, state: session.state };
    },

    'regent.unload': async (params, caller) => {
      const orquestra = ctx.getOrquestra();
      if (caller === params.name) {
        throw new OrqError('USAGE', 'Um regente não pode descarregar a si mesmo. Peça ao usuário ou use a interface.');
      }
      const kind = orquestra.topology.kindOf(params.name);
      if (!kind) throw new OrqError('NOT_FOUND', `Terminal ${params.name} não existe.`);
      if (kind !== 'terminal') throw new OrqError('USAGE', 'Só terminais podem ser descarregados.');

      const session = orquestra.session(params.name);
      if (!session) throw new OrqError('NOT_FOUND', `Terminal ${params.name} não existe.`);
      const descriptor = orquestra.describeTerminals().find((terminal) => terminal.name === params.name);
      if (descriptor?.unloaded) return { name: params.name };

      const queued = orquestra.broker.queued(params.name);
      if (!isReadySessionState(session.state) || queued > 0) {
        const stateLabel = STATE_LABELS[session.state];
        throw new OrqError(
          'USAGE',
          `Não é possível descarregar ${params.name}: estado ${stateLabel}, ${queued} pedido(s) na fila. Espere ficar ocioso e a fila esvaziar; se estiver travado, use orq restart ${params.name}.`,
        );
      }

      const unloaded = await orquestra.unloadTerminal(params.name);
      ctx.opts.send({ kind: 'event', event: { type: 'terminal.replaced', info: ctx.info(unloaded) } });
      ctx.opts.send({ kind: 'event', event: { type: 'notice', level: 'info', message: `${caller} descarregou ${params.name}.` } });
      ctx.recordPids();
      ctx.changed();
      return { name: params.name };
    },

    'regent.load': async (params, caller) => {
      const orquestra = ctx.getOrquestra();
      if (caller === params.name) {
        throw new OrqError('USAGE', 'Um regente não pode recarregar a si mesmo. Peça ao usuário ou use a interface.');
      }
      const kind = orquestra.topology.kindOf(params.name);
      if (!kind) throw new OrqError('NOT_FOUND', `Terminal ${params.name} não existe.`);
      if (kind !== 'terminal') throw new OrqError('USAGE', 'Só terminais podem ser recarregados.');

      const session = orquestra.session(params.name);
      if (!session) throw new OrqError('NOT_FOUND', `Terminal ${params.name} não existe.`);
      const descriptor = orquestra.describeTerminals().find((terminal) => terminal.name === params.name);
      if (!descriptor?.unloaded) return { name: params.name, state: session.state };

      const loaded = await orquestra.restartTerminal(params.name);
      ctx.opts.send({ kind: 'event', event: { type: 'terminal.replaced', info: ctx.info(loaded) } });
      ctx.opts.send({ kind: 'event', event: { type: 'notice', level: 'info', message: `${caller} recarregou ${params.name}.` } });
      ctx.recordPids();
      ctx.changed();
      return { name: loaded.name, state: loaded.state };
    },

    'regent.link': async (params) => {
      ctx.getOrquestra().connect(params.a, params.b);
      ctx.changed();
      ctx.opts.send({ kind: 'event', event: { type: 'edge.added', a: params.a, b: params.b } });
      return {};
    },

    'regent.unlink': async (params) => {
      ctx.getOrquestra().disconnect(params.a, params.b);
      ctx.changed();
      ctx.opts.send({ kind: 'event', event: { type: 'edge.removed', a: params.a, b: params.b } });
      return {};
    },

    'regent.brief': async (params, caller) => {
      const orquestra = ctx.getOrquestra();
      const targetDesc = orquestra.describeTerminals().find((t) => t.name === params.target);
      if (!targetDesc) throw new OrqError('NOT_FOUND', `Terminal ${params.target} não existe.`);
      const persona = ctx.resolvePersona(params.persona);
      orquestra.brief(params.target, caller, personaBrief(persona, { regent: targetDesc.regente }));
      return {};
    },

    'persona.list': async () => {
      const projectPersonas = ctx.getProject()?.state.personas() ?? [];
      const globalPersonas = ctx.personaStore.list();
      const seen = new Set<string>();
      const personas: Array<{ name: string; scope: PersonaScope }> = [];
      for (const p of projectPersonas) {
        seen.add(p.name);
        personas.push({ name: p.name, scope: 'project' });
      }
      for (const p of globalPersonas) {
        if (!seen.has(p.name)) {
          seen.add(p.name);
          personas.push({ name: p.name, scope: 'global' });
        }
      }
      return { personas };
    },

    'persona.show': async (params) => {
      const projectPersona = ctx.getProject()?.state.personas().find((p) => p.name === params.name);
      if (projectPersona) return { name: projectPersona.name, scope: 'project', text: projectPersona.text };
      const globalPersona = ctx.personaStore.get(params.name);
      if (globalPersona) return { name: globalPersona.name, scope: 'global', text: globalPersona.text };
      throw new OrqError('NOT_FOUND', `A função ${params.name} não existe. Veja as disponíveis com orq persona list.`);
    },

    'persona.write': async (params) => {
      if (params.global) {
        const { created } = ctx.personaStore.write({ name: params.name, text: params.text });
        return { name: params.name, scope: 'global', created };
      }
      const current = ctx.requireProject();
      const { created } = current.state.writePersona({ name: params.name, text: params.text });
      ctx.changed();
      return { name: params.name, scope: 'project', created };
    },

    'persona.remove': async (params) => {
      if (params.global) {
        const removed = ctx.personaStore.remove(params.name);
        if (!removed) throw new OrqError('NOT_FOUND', `A função global ${params.name} não existe.`);
        return {};
      }
      const current = ctx.requireProject();
      const removed = current.state.removePersona(params.name);
      if (!removed) throw new OrqError('NOT_FOUND', `A função ${params.name} do projeto não existe.`);
      ctx.changed();
      return {};
    },
  };

  return async (method, params, caller) => {
    ctx.opts.log.info({ regente: caller, method, params }, 'comando de regente');
    return (regentHandlers[method] as (p: unknown, c: string) => Promise<never>)(params, caller);
  };
}
