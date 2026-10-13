import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import type { Logger } from './log.js';

const recentSchema = z.array(z.object({ dir: z.string().min(1), name: z.string(), openedAt: z.string() }));
export type RecentProject = z.infer<typeof recentSchema>[number];

export class RecentProjects {
  constructor(private readonly opts: { file: string; log: Logger; limit?: number }) {}

  list(): RecentProject[] {
    if (!existsSync(this.opts.file)) return [];
    try {
      return recentSchema.parse(JSON.parse(readFileSync(this.opts.file, 'utf8')));
    } catch (error) {
      this.opts.log.warn({ err: error, file: this.opts.file }, 'lista de projetos recentes inválida; ignorada');
      return [];
    }
  }

  touch(dir: string, now = new Date()): RecentProject[] {
    const others = this.list().filter((project) => project.dir.toLowerCase() !== dir.toLowerCase());
    const projects = [{ dir, name: basename(dir), openedAt: now.toISOString() }, ...others].slice(0, this.opts.limit ?? 20);
    mkdirSync(dirname(this.opts.file), { recursive: true });
    writeFileSync(this.opts.file, JSON.stringify(projects, null, 2));
    return projects;
  }
}
