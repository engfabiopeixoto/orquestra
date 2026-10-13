import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptySettings, OrqError, reservedArgError, settingsSchema, type Settings, type SettingsInput } from '@orquestra/shared';
import type { Logger } from './log.js';

/** Padrões dos agentes (argumentos por tipo), em settings.json na pasta de dados. */
export class SettingsStore {
  constructor(private readonly opts: { file: string; log: Logger }) {}

  get(): Settings {
    if (!existsSync(this.opts.file)) return emptySettings();
    try {
      return settingsSchema.parse(JSON.parse(readFileSync(this.opts.file, 'utf8')));
    } catch (error) {
      this.opts.log.warn({ err: error, file: this.opts.file }, 'padrões dos agentes inválidos; usando vazios');
      return emptySettings();
    }
  }

  update(input: SettingsInput): Settings {
    const settings = settingsSchema.parse(input);
    for (const agent of ['claude', 'agy', 'codex'] as const) {
      const reserved = reservedArgError(agent, settings.defaultArgs[agent]);
      if (reserved) throw new OrqError('USAGE', `Padrão do ${agent}: ${reserved}`);
    }
    mkdirSync(dirname(this.opts.file), { recursive: true });
    const temporary = `${this.opts.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
    renameSync(temporary, this.opts.file);
    return settings;
  }
}
