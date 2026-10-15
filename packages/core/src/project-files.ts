import { execFile } from 'node:child_process';
import { existsSync, type Dirent } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { OrqError, type ProjectFile } from '@orquestra/shared';

const MAX_TEXT = 512 * 1024;
/**
 * Quanto tempo o resultado do git status/diff vale. O explorador consulta a cada poucos segundos e cada consulta
 * cria processos git: o prazo de 10 s limita isso a dois processos por projeto a cada 10 s (zero se a janela
 * está oculta ou o projeto não está ativo, pois o renderer não pergunta).
 */
const GIT_CACHE_MS = 10_000;
const HIDDEN = new Set(['.git', '.orquestra', 'node_modules', '.next', '.venv', '__pycache__']);
type Change = Pick<ProjectFile, 'change' | 'additions' | 'deletions'>;
const unchanged = (): Change => ({ change: 'none', additions: 0, deletions: 0 });
const slash = (value: string) => value.replaceAll('\\', '/');
const within = (root: string, target: string) => { const path = relative(root, target); return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`); };
const lines = (text: string) => text === '' ? [] : text.replaceAll('\r\n', '\n').replace(/\n$/, '').split('\n');

export function compareText(before: string, after: string): Change {
  if (before === after) return unchanged();
  const counts = new Map<string, number>();
  for (const line of lines(before)) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of lines(after)) {
    const count = counts.get(line) ?? 0;
    if (count) counts.set(line, count - 1);
    else additions++;
  }
  const deletions = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return { change: additions && !deletions ? 'added' : deletions && !additions ? 'removed' : 'modified', additions, deletions };
}

export class ProjectFiles {
  private readonly root: string;
  private readonly canonical: Promise<string>;
  private gitRoot: string | null | undefined;
  private changes = new Map<string, Change>();
  private gitAt = 0;
  private gitPending: Promise<boolean> | null = null;
  private baseline = new Map<string, string | null>();
  private directories = new Map<string, Map<string, ProjectFile>>();
  private newFiles = new Set<string>();
  constructor(root: string, private readonly options: { gitCacheMs?: number } = {}) {
    this.root = resolve(root);
    this.canonical = realpath(this.root);
  }

  private git(args: string[]): Promise<string> {
    const standard = join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'cmd', 'git.exe');
    const command = existsSync(standard) ? standard : 'git';
    return new Promise((resolveResult, reject) => execFile(command, ['--literal-pathspecs', '-C', this.root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout) => error ? reject(error) : resolveResult(stdout)));
  }

  private async safePath(input: string): Promise<string> {
    if (isAbsolute(input) || input.includes('\0') || slash(input).split('/').some((part) => part === '..' || part === '.git')) throw new OrqError('USAGE', 'Escolha um arquivo dentro do projeto.');
    const target = resolve(this.root, input);
    if (!within(this.root, target)) throw new OrqError('USAGE', 'O caminho fica fora do projeto.');
    let existing = target;
    while (true) {
      try {
        if (!within(await this.canonical, await realpath(existing))) throw new OrqError('USAGE', 'Este link aponta para fora do projeto.');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (existing === this.root) throw new OrqError('NOT_FOUND', 'A pasta do projeto não existe mais.');
        existing = dirname(existing);
      }
    }
    return target;
  }

  private async gitChanges(): Promise<boolean> {
    if (this.gitPending) return this.gitPending;
    if (Date.now() - this.gitAt < (this.options.gitCacheMs ?? GIT_CACHE_MS) && this.gitRoot !== undefined) return this.gitRoot !== null;
    this.gitPending = (async () => {
      try {
        if (this.gitRoot === undefined) this.gitRoot = (await this.git(['rev-parse', '--show-toplevel'])).trim();
        if (!this.gitRoot) return false;
        const status = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
        const prefix = slash(relative(this.gitRoot, this.root));
        const toLocal = (path: string) => prefix ? path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null : path;
        const changes = new Map<string, Change>();
        const records = status.split('\0');
        for (let i = 0; i < records.length; i++) {
          const record = records[i]!;
          if (!record) continue;
          const flag = record.slice(0, 2);
          const path = toLocal(record.slice(3));
          if (/[RC]/.test(flag)) i++; // porcelain -z includes the old path for rename/copy.
          if (!path) continue;
          changes.set(path, { change: flag.includes('D') ? 'removed' : flag === '??' || flag.includes('A') ? 'added' : 'modified', additions: 0, deletions: 0 });
        }
        let diff: string;
        try { diff = await this.git(['diff', '--numstat', '-z', '--no-renames', '--relative', 'HEAD', '--', '.']); }
        catch { diff = await this.git(['diff', '--numstat', '-z', '--no-renames', '--relative', '--', '.']); }
        for (const record of diff.split('\0')) {
          const match = record.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
          if (!match) continue;
          const additions = Number(match[1]) || 0;
          const deletions = Number(match[2]) || 0;
          const path = match[3]!;
          const previous = changes.get(path);
          changes.set(path, { additions, deletions, change: previous?.change === 'removed' || previous?.change === 'added' ? previous.change : additions && !deletions ? 'added' : deletions && !additions ? 'removed' : 'modified' });
        }
        this.changes = changes;
        return true;
      } catch {
        this.gitRoot = null;
        this.changes.clear();
        return false;
      } finally { this.gitAt = Date.now(); this.gitPending = null; }
    })();
    return this.gitPending;
  }

  private async text(path: string): Promise<string | null> {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_TEXT) return null;
      const buffer = await readFile(path);
      if (buffer.includes(0)) return null;
      return buffer.toString('utf8');
    } catch { return null; }
  }

  async list(input: string) {
    const absolute = await this.safePath(input);
    const directory = slash(relative(this.root, absolute));
    const git = await this.gitChanges();
    let disk: Dirent[];
    try { disk = await readdir(absolute, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new OrqError('APP_UNAVAILABLE', 'Não foi possível ler esta pasta.');
      disk = [];
    }
    const filtered = disk.filter((entry) => !HIDDEN.has(entry.name));
    const truncated = filtered.length > 2000;
    const previous = this.directories.get(directory);
    const current = new Map<string, ProjectFile>();
    // Work in small batches to avoid opening thousands of files at once.
    for (let index = 0; index < Math.min(filtered.length, 2000); index += 20) {
      const entries = await Promise.all(filtered.slice(index, Math.min(index + 20, 2000)).map(async (entry): Promise<ProjectFile> => {
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file';
        let change = git ? this.changes.get(path) ?? unchanged() : unchanged();
        if (!git && kind === 'file') {
          const value = await this.text(join(absolute, entry.name));
          if (!this.baseline.has(path)) {
            this.baseline.set(path, previous && !previous.has(path) ? '' : value);
            if (previous && !previous.has(path)) this.newFiles.add(path);
            if (previous && !previous.has(path)) change = { change: 'added', additions: value ? lines(value).length : 0, deletions: 0 };
          } else {
            const before = this.baseline.get(path);
            if (before !== null && before !== undefined && value !== null) change = compareText(before, value);
            if (this.newFiles.has(path)) change.change = 'added';
          }
          this.changes.set(path, change);
        }
        return { name: entry.name, path, kind, ...change };
      }));
      for (const entry of entries) current.set(entry.path, entry);
    }
    if (!git && previous) for (const entry of previous.values()) {
      if (!current.has(entry.path)) {
        const before = this.baseline.get(entry.path);
        this.changes.set(entry.path, { change: 'removed', additions: 0, deletions: before ? lines(before).length : 0 });
      }
    }
    this.directories.set(directory, current);
    const entries = new Map(current);
    for (const [path, change] of this.changes) {
      if (change.change === 'none') continue;
      const local = directory ? path.startsWith(`${directory}/`) ? path.slice(directory.length + 1) : null : path;
      if (!local || HIDDEN.has(local.split('/')[0]!)) continue;
      const parts = local.split('/');
      const directPath = directory ? `${directory}/${parts[0]}` : parts[0]!;
      const entry = entries.get(directPath);
      if (parts.length > 1) {
        if (entry?.kind === 'directory') {
          entry.change = entry.change === 'none' ? change.change : entry.change === change.change ? entry.change : 'modified';
        } else if (!entry) entries.set(directPath, { name: parts[0]!, path: directPath, kind: 'directory', ...change });
      } else if (!entry) entries.set(path, { name: basename(path), path, kind: 'file', ...change });
    }
    return { entries: [...entries.values()].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'pt-BR', { numeric: true })), comparison: git ? 'git' as const : 'session' as const, truncated };
  }

  async read(input: string) {
    const absolute = await this.safePath(input);
    const path = slash(relative(this.root, absolute));
    const git = await this.gitChanges();
    let content: string | null = null;
    let kind: 'text' | 'binary' | 'large' | 'removed' = 'text';
    try {
      const info = await lstat(absolute);
      if (!info.isFile()) throw new OrqError('USAGE', 'Selecione um arquivo comum.');
      if (info.size > MAX_TEXT) kind = 'large';
      else {
        const buffer = await readFile(absolute);
        if (buffer.includes(0)) kind = 'binary';
        else content = buffer.toString('utf8');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (this.changes.get(path)?.change !== 'removed') throw new OrqError('NOT_FOUND', 'Este arquivo não existe mais.');
      kind = 'removed';
      content = this.baseline.get(path) ?? null;
    }
    let diff: string | null = null;
    if (kind === 'text' || kind === 'removed') {
      if (git) {
        try { diff = await this.git(['diff', '--no-ext-diff', '--no-renames', '--no-color', 'HEAD', '--', path]); }
        catch { diff = null; }
        if (!diff && this.changes.get(path)?.change === 'added' && content !== null) diff = lines(content).map((line) => `+${line}`).join('\n');
      } else {
        const before = this.baseline.get(path);
        if (before !== undefined && before !== null && before !== content) diff = [...lines(before).map((line) => `-${line}`), ...lines(content ?? '').map((line) => `+${line}`)].join('\n');
      }
    }
    return { path, kind, content, diff: diff || null };
  }
}
