import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { loadWorkspace, ProjectFiles, saveWorkspace, WorkspaceSaver } from '@orquestra/core';
import { OrqError, type Workspace } from '@orquestra/shared';
import { WorkspaceState } from '../workspace-state.js';
import type { BridgeContext, Handlers, OpenProject } from './context.js';

type ProjectMethod = 'files.list' | 'files.read' | 'project.open' | 'project.close';

/** Controla abertura, restauração e fechamento de projeto e explorador de arquivos. */
export function createProjectController(ctx: BridgeContext) {
  let fileExplorer: { dir: string; files: ProjectFiles } | null = null;

  /**
   * Grava e solta o projeto antes de encerrar: depois da remoção os descritores dos terminais somem, e
   * cada 'removed' agendaria uma gravação nova que poria o projeto vazio por cima do arquivo.
   */
  function detachProject(): void {
    const project = ctx.getProject();
    if (!project) return;
    ctx.abortQuality();
    project.saver.flush();
    project.saver.dispose();
    ctx.setProject(null);
    fileExplorer = null;
    ctx.removedTerminals.clear();
  }

  async function closeProject(): Promise<void> {
    const project = ctx.getProject();
    if (!project) return;
    const portalIds = project.state.browserNodes().map((portal) => portal.id);
    const orquestra = ctx.getOrquestra();
    detachProject();
    for (const session of orquestra.sessions()) await orquestra.removeTerminal(session.name);
    for (const note of orquestra.notes.list()) orquestra.removeNote(note.name);
    for (const portal of portalIds) orquestra.topology.remove(portal);
  }

  function restore(current: OpenProject, workspace: Workspace): void {
    const orquestra = ctx.getOrquestra();
    current.state.setBrowserNodes(workspace.portals ?? []);
    for (const portal of workspace.portals ?? []) orquestra.topology.add(portal.id, 'portal');
    for (const note of workspace.notes) {
      orquestra.restoreNote({ id: note.id, name: note.name, content: note.content, revision: note.revision, updatedBy: note.updatedBy });
    }
    for (const terminal of workspace.terminals) {
      try {
        orquestra.createTerminal({
          name: terminal.name,
          agent: terminal.agent,
          cwd: terminal.cwd,
          id: terminal.id,
          args: terminal.args,
          resume: terminal.resume,
          agentSessionId: terminal.agentSessionId,
          regente: terminal.regente,
          persona: terminal.persona,
          monitor: terminal.monitor,
          model: terminal.model,
          unloaded: terminal.unloaded,
          sessionDirs: terminal.sessionDirs,
        });
      } catch (error) {
        current.state.forget(terminal.name);
        ctx.opts.log.warn({ err: error, terminal: terminal.name }, 'não foi possível reabrir o terminal');
        ctx.opts.send({
          kind: 'event',
          event: { type: 'notice', level: 'warn', message: `Não foi possível reabrir o terminal ${terminal.name}: ${(error as Error).message}` },
        });
      }
    }
    for (const { a, b } of workspace.connections) {
      if (orquestra.topology.kindOf(a) && orquestra.topology.kindOf(b)) orquestra.connect(a, b);
    }
    ctx.recordPids();
  }

  function getFileExplorer(dir: string): ProjectFiles {
    if (fileExplorer?.dir !== dir) fileExplorer = { dir, files: new ProjectFiles(dir) };
    return fileExplorer.files;
  }

  const handlers: Pick<Handlers, ProjectMethod> = {
    'files.list': async ({ path }) => getFileExplorer(ctx.requireProject().dir).list(path),
    'files.read': async ({ path }) => getFileExplorer(ctx.requireProject().dir).read(path),

    'project.open': async ({ dir }) => {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new OrqError('USAGE', `A pasta ${dir} não existe. Escolha outra pasta de projeto.`);
      }
      const existing = ctx.getProject();
      if (existing?.dir === dir) return ctx.snapshot(existing);
      await closeProject();
      const loaded = loadWorkspace(dir);
      const layout = Object.fromEntries(
        [...loaded.workspace.terminals, ...loaded.workspace.notes].map((node) => [node.name, { ...node.position, ...node.size }]),
      );
      const current: OpenProject = {
        dir,
        name: basename(dir),
        state: new WorkspaceState({
          layout,
          groups: loaded.workspace.groups,
          elementIds: Object.fromEntries([...loaded.workspace.terminals, ...loaded.workspace.notes].map((element) => [element.name, element.id])),
          viewport: loaded.workspace.viewport,
          personas: loaded.workspace.personas,
          presentations: Object.fromEntries(
            loaded.workspace.terminals
              .filter((terminal) => terminal.blurred !== undefined || terminal.locked !== undefined)
              .map((terminal) => [terminal.name, { blurred: terminal.blurred, locked: terminal.locked }]),
          ),
        }),
        saver: new WorkspaceSaver({ save: () => saveWorkspace(dir, ctx.capture(current)), delayMs: ctx.opts.saveDelayMs, log: ctx.opts.log }),
      };
      ctx.setProject(current);
      if (loaded.backup) {
        ctx.opts.log.warn({ dir, backup: loaded.backup, problem: loaded.problem }, 'workspace inválido; projeto aberto vazio');
        ctx.opts.send({
          kind: 'event',
          event: {
            type: 'notice',
            level: 'warn',
            message: `O workspace de ${current.name} estava inválido e foi guardado em ${loaded.backup}. O projeto abriu vazio. Detalhe: ${loaded.problem}`,
          },
        });
      }
      restore(current, loaded.workspace);
      ctx.recent.touch(dir);
      ctx.opts.log.info(
        { dir, terminals: loaded.workspace.terminals.length, notes: loaded.workspace.notes.length },
        'projeto aberto',
      );
      return ctx.snapshot(current);
    },

    'project.close': async () => {
      await closeProject();
      return {};
    },
  };

  return { detachProject, closeProject, handlers };
}
