import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;

export class Screen {
  private readonly terminal: InstanceType<typeof Terminal>;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  }

  write(data: string): Promise<void> {
    return new Promise((resolve) => this.terminal.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  text(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      lines.push(buffer.getLine(index)?.translateToString(true).trimEnd() ?? '');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }
}

export function hasAnsi(text: string): boolean {
  return /\x1b\[|\x1b\]|\x9b/.test(text);
}
