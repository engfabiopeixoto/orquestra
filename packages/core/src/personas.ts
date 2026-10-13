import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { personaSchema, type Persona } from '@orquestra/shared';
import type { Logger } from './log.js';

const personasFileSchema = z.array(personaSchema);

export class PersonaStore {
  constructor(private readonly opts: { file: string; log: Logger }) {}

  list(): Persona[] {
    if (!existsSync(this.opts.file)) return [];
    try {
      return personasFileSchema.parse(JSON.parse(readFileSync(this.opts.file, 'utf8')));
    } catch (error) {
      this.opts.log.warn({ err: error, file: this.opts.file }, 'funções globais inválidas; usando vazias');
      return [];
    }
  }

  get(name: string): Persona | undefined {
    return this.list().find((persona) => persona.name === name);
  }

  write(persona: Persona): { created: boolean } {
    const valid = personaSchema.parse(persona);
    const personas = this.list();
    const index = personas.findIndex((entry) => entry.name === valid.name);
    const created = index < 0;
    if (created) personas.push(valid);
    else personas[index] = valid;

    mkdirSync(dirname(this.opts.file), { recursive: true });
    const temporary = `${this.opts.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(personas, null, 2)}\n`);
    renameSync(temporary, this.opts.file);
    return { created };
  }

  remove(name: string): boolean {
    const personas = this.list();
    const filtered = personas.filter((entry) => entry.name !== name);
    if (filtered.length === personas.length) return false;

    mkdirSync(dirname(this.opts.file), { recursive: true });
    const temporary = `${this.opts.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(filtered, null, 2)}\n`);
    renameSync(temporary, this.opts.file);
    return true;
  }
}
