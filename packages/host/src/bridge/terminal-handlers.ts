import { OrqError, personaBrief, regentGuide, type HostAgent } from '@orquestra/shared';
import { placeBeside, TERMINAL_SIZE } from '../placement.js';
import type { BridgeContext, Handlers } from './context.js';

type TerminalMethod =
  | 'terminal.create'
  | 'terminal.update'
  | 'terminal.remove'
  | 'terminal.restart'
  | 'terminal.unload'
  | 'terminal.presentation'
  | 'terminal.duplicate'
  | 'terminal.model'
  | 'terminal.rename'
  | 'terminal.input'
  | 'terminal.send'
  | 'terminal.key'
  | 'terminal.resize'
  | 'terminal.snapshot'
  | 'edge.connect'
  | 'edge.disconnect'
  | 'prompt.cancel';

/** Cria os handlers de ciclo de vida, I/O de terminais, arestas e cancelamento de prompts. */
export function createTerminalHandlers(ctx: BridgeContext): Pick<Handlers, TerminalMethod> {
  return {
    'terminal.create': async ({ name, agent, cwd, resume, args, regente, persona, monitor, groupId }) => {
      if (agent === 'shell' && persona) {
        throw new OrqError('USAGE', 'O shell não recebe funções.');
      }
      const orquestra = ctx.getOrquestra();
      const resolvedPersona = persona ? ctx.resolvePersona(persona) : undefined;
      const placement = groupId ? ctx.prepareGroupedNode(groupId, 'terminal', name) : undefined;
      const session = await ctx.createTerminalFor({ id: placement?.id, name, agent, cwd, resume, args, regente, persona, monitor });
      ctx.removedTerminals.forget(name);
      if (placement && groupId) {
        ctx.requireProject().state.place(name, placement.rect);
        ctx.requireProject().state.grouping.assign(groupId, [{ kind: 'terminal', id: session.id }], ctx.groupElements());
        ctx.emitGroupLayout();
      }
      if (session.adapter.acceptsPrompts) {
        if (resolvedPersona) {
          orquestra.brief(session.name, 'Orquestra', personaBrief(resolvedPersona, { regent: Boolean(regente) }));
        } else if (regente) {
          orquestra.brief(session.name, 'Orquestra', regentGuide());
        }
      }
      const terminalInfo = ctx.info(session);
      const existingRect = ctx.requireProject().state.rectOf(name);
      const layoutRects = Object.values(ctx.requireProject().state.layout());
      const rect = placement?.rect ?? existingRect ?? {
        x: layoutRects.length ? Math.max(...layoutRects.map((item) => item.x + item.width)) + 40 : 80,
        y: 80,
        ...TERMINAL_SIZE,
      };
      ctx.opts.send({ kind: 'event', event: { type: 'terminal.added', info: terminalInfo, rect, connectedTo: null } });
      return terminalInfo;
    },

    'terminal.update': async ({ name, ...changes }) => {
      const orquestra = ctx.getOrquestra();
      ctx.opts.log.info({ terminal: name, method: 'terminal.update', keys: Object.keys(changes) }, 'comando da interface');
      const before = orquestra.describeTerminals().find((terminal) => terminal.name === name);
      const session = await orquestra.updateTerminal(name, changes);
      ctx.removedTerminals.forget(name);
      if (changes.newName && changes.newName !== name) {
        ctx.removedTerminals.forget(changes.newName);
        ctx.getProject()?.state.rename(name, changes.newName);
      }
      if (changes.regente === true && !before?.regente && session.adapter.acceptsPrompts) {
        orquestra.brief(session.name, 'Orquestra', regentGuide());
      }
      ctx.recordPids();
      ctx.changed();
      const terminalInfo = ctx.info(session);
      ctx.opts.send({
        kind: 'event',
        event: { type: 'terminal.replaced', info: terminalInfo, ...(changes.newName && changes.newName !== name ? { oldName: name } : {}) },
      });
      return terminalInfo;
    },

    'terminal.remove': async ({ name }) => {
      ctx.opts.log.info({ terminal: name, method: 'terminal.remove' }, 'comando da interface');
      ctx.requireSession(name);
      await ctx.getOrquestra().removeTerminal(name);
      ctx.changed();
      return {};
    },

    'terminal.restart': async ({ name }) => {
      ctx.opts.log.info({ terminal: name, method: 'terminal.restart' }, 'comando da interface');
      const session = await ctx.getOrquestra().restartTerminal(name);
      ctx.recordPids();
      ctx.changed();
      const terminalInfo = ctx.info(session);
      ctx.opts.send({ kind: 'event', event: { type: 'terminal.replaced', info: terminalInfo } });
      return terminalInfo;
    },

    'terminal.unload': async ({ name }) => {
      ctx.opts.log.info({ terminal: name, method: 'terminal.unload' }, 'comando da interface');
      const session = await ctx.getOrquestra().unloadTerminal(name);
      ctx.recordPids();
      ctx.changed();
      const terminalInfo = ctx.info(session);
      ctx.opts.send({ kind: 'event', event: { type: 'terminal.replaced', info: terminalInfo } });
      return terminalInfo;
    },

    'terminal.presentation': async ({ name, ...changes }) => {
      const current = ctx.requireProject();
      const session = ctx.requireSession(name);
      current.state.setPresentation(name, changes);
      ctx.changed();
      return ctx.info(session);
    },

    'terminal.duplicate': async ({ name }) => {
      const current = ctx.requireProject();
      const orquestra = ctx.getOrquestra();
      const source = orquestra.describeTerminals().find((terminal) => terminal.name === name);
      if (!source) throw new OrqError('NOT_FOUND', `Terminal ${name} não existe.`);
      const persona = source.persona ? ctx.resolvePersona(source.persona) : undefined;
      let newName = '';
      for (let index = 1; ; index++) {
        const suffix = index === 1 ? '-copia' : `-copia-${index}`;
        newName = name.slice(0, 40 - suffix.length) + suffix;
        if (!orquestra.topology.kindOf(newName)) break;
      }
      const session = await ctx.createTerminalFor({
        name: newName,
        agent: source.agent as HostAgent,
        cwd: source.cwd,
        args: [...source.args],
        resume: source.resume,
        regente: source.regente,
        persona: source.persona ?? undefined,
        monitor: source.monitor,
        model: source.model,
      });
      ctx.removedTerminals.forget(newName);
      const origin = current.state.rectOf(name) ?? { x: 80, y: 80, ...TERMINAL_SIZE };
      const size = { width: origin.width, height: origin.height };
      const rect = { ...placeBeside(origin, Object.values(current.state.layout()), size), ...size };
      current.state.place(newName, rect);
      if (current.state.presentation(name).blurred) current.state.setPresentation(newName, { blurred: true });
      if (persona && session.adapter.acceptsPrompts) orquestra.brief(newName, 'Orquestra', personaBrief(persona, { regent: source.regente }));
      else if (source.regente && session.adapter.acceptsPrompts) orquestra.brief(newName, 'Orquestra', regentGuide());
      ctx.changed();
      const terminalInfo = ctx.info(session);
      ctx.opts.send({ kind: 'event', event: { type: 'terminal.added', info: terminalInfo, rect, connectedTo: null } });
      return { info: terminalInfo, rect };
    },

    'terminal.model': async ({ name, model }) => {
      ctx.opts.log.info({ terminal: name, method: 'terminal.model', model }, 'comando da interface');
      return ctx.info(await ctx.getOrquestra().setModel(name, model));
    },

    'terminal.rename': async ({ name, newName }) => {
      const session = ctx.getOrquestra().renameTerminal(name, newName);
      ctx.removedTerminals.forget(name);
      ctx.removedTerminals.forget(newName);
      ctx.getProject()?.state.rename(name, newName);
      ctx.changed();
      const terminalInfo = ctx.info(session);
      ctx.opts.send({ kind: 'event', event: { type: 'terminal.replaced', info: terminalInfo, oldName: name } });
      return terminalInfo;
    },

    'terminal.input': async ({ name, data }) => {
      const session = ctx.requireSession(name);
      if (session.state === 'exited') throw new OrqError('APP_UNAVAILABLE', `Recarregue o terminal ${name} para interagir.`);
      session.userInput(data);
      return {};
    },

    'terminal.send': async ({ name, text }) => {
      ctx.opts.log.info({ terminal: name, method: 'terminal.send', chars: text.length }, 'comando da interface');
      await ctx.requireSession(name).sendMessage(text);
      return {};
    },

    'terminal.key': async ({ name, key }) => {
      ctx.requireSession(name).sendKey(key);
      return {};
    },

    'terminal.resize': async ({ name, cols, rows }) => {
      ctx.requireSession(name).resize(cols, rows);
      return {};
    },

    'terminal.snapshot': async ({ name }) => {
      const session = ctx.requireSession(name);
      await session.settle();
      // No mesmo tique: a saída enviada antes da resposta já está no retrato, e a interface a descarta
      // (ainda não está ao vivo). Sem isto, o lote pendente chegaria depois e repetiria linhas.
      ctx.batcher.flush();
      return session.snapshot();
    },

    'edge.connect': async ({ a, b }) => {
      ctx.getOrquestra().connect(a, b);
      ctx.changed();
      return {};
    },

    'edge.disconnect': async ({ a, b }) => {
      ctx.getOrquestra().disconnect(a, b);
      ctx.changed();
      return {};
    },

    'prompt.cancel': async ({ askId }) => ctx.getOrquestra().broker.cancelWithStatus(askId),
  };
}
