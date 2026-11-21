import { OrqError, type PersonaScope } from '@orquestra/shared';
import type { BridgeContext, Handlers } from './context.js';

type AppMethod =
  | 'recent.list'
  | 'settings.get'
  | 'settings.update'
  | 'persona.list'
  | 'persona.save'
  | 'persona.remove'
  | 'models.catalog'
  | 'models.refresh';

/** Cria os handlers globais do app: projetos recentes, preferências, funções da interface e catálogo de modelos. */
export function createAppHandlers(ctx: BridgeContext): Pick<Handlers, AppMethod> {
  return {
    'recent.list': async () => ({ projects: ctx.recent.list() }),
    'settings.get': async () => ctx.settings.get(),
    'settings.update': async (next) => ctx.settings.update(next),

    'persona.list': async () => {
      const projectPersonas = ctx.getProject()?.state.personas() ?? [];
      const globalPersonas = ctx.personaStore.list();
      const seen = new Set<string>();
      const personas: Array<{ name: string; scope: PersonaScope; text: string }> = [];
      for (const p of projectPersonas) {
        seen.add(p.name);
        personas.push({ name: p.name, scope: 'project', text: p.text });
      }
      for (const p of globalPersonas) {
        if (!seen.has(p.name)) {
          seen.add(p.name);
          personas.push({ name: p.name, scope: 'global', text: p.text });
        }
      }
      return { personas };
    },

    'persona.save': async ({ name, text, scope }) => {
      if (scope === 'project') {
        const current = ctx.requireProject();
        current.state.writePersona({ name, text });
        ctx.changed();
      } else {
        ctx.personaStore.write({ name, text });
      }
      return {};
    },

    'persona.remove': async ({ name, scope }) => {
      if (scope === 'project') {
        const current = ctx.requireProject();
        const removed = current.state.removePersona(name);
        if (!removed) throw new OrqError('NOT_FOUND', `A função ${name} do projeto não existe.`);
        ctx.changed();
      } else {
        const removed = ctx.personaStore.remove(name);
        if (!removed) throw new OrqError('NOT_FOUND', `A função global ${name} não existe.`);
      }
      return {};
    },

    'models.catalog': async () => ctx.modelCatalog.get(),
    'models.refresh': async ({ agent }) => ctx.modelCatalog.refresh(agent),
  };
}
