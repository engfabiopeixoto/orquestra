import serializePkg from '@xterm/addon-serialize';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializePkg;

export class Screen {
  private readonly terminal: InstanceType<typeof Terminal>;
  private readonly serializer: InstanceType<typeof SerializeAddon>;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    // O addon declara o Terminal do @xterm/xterm; o headless tem a mesma API usada pelo addon.
    this.terminal.loadAddon(this.serializer as unknown as Parameters<typeof this.terminal.loadAddon>[0]);
  }

  write(data: string): Promise<void> {
    return new Promise((resolve) => this.terminal.write(data, resolve));
  }

  /**
   * Respostas do terminal às consultas do programa (identificação, posição do cursor).
   * O ConPTY do node-pty espera a identificação antes de mostrar qualquer saída.
   */
  onReply(listener: (data: string) => void): void {
    this.terminal.onData(listener);
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  dispose(): void {
    this.terminal.dispose();
  }

  text(): string {
    return this.lines(0, this.terminal.buffer.active.length).join('\n');
  }

  /** Retrato da tela e do histórico, para restaurar num xterm limpo do mesmo tamanho. */
  serialize(): string {
    return this.serializer.serialize();
  }

  tail(lines: number): string {
    return this.text().split('\n').slice(-lines).join('\n');
  }

  /** Só a área visível: padrões de diálogo não podem casar com o histórico. */
  visible(): string {
    const buffer = this.terminal.buffer.active;
    return this.lines(buffer.viewportY, buffer.viewportY + this.terminal.rows).join('\n');
  }

  private lines(from: number, to: number): string[] {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let index = from; index < to; index++) {
      lines.push(buffer.getLine(index)?.translateToString(true).trimEnd() ?? '');
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
}
