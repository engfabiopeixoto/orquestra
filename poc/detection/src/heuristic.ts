export class SilenceDetector {
  private armed = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: { quietMs: number; onQuiet: () => void }) {}

  arm(): void {
    this.disarm();
    this.armed = true;
  }

  feed(): void {
    if (!this.armed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.armed = false;
      this.opts.onQuiet();
    }, this.opts.quietMs);
  }

  disarm(): void {
    this.armed = false;
    clearTimeout(this.timer);
  }
}

export function newLinesSince(before: string, after: string, prompt: string): string {
  const seen = new Set(before.split('\n').map((line) => line.trim()));
  const promptHead = prompt.split('\n')[0]!.trim().slice(0, 30);
  const fresh = after
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !seen.has(line.trim()))
    .filter((line) => promptHead === '' || !line.includes(promptHead));
  while (fresh[0]?.trim() === '') fresh.shift();
  while (fresh.at(-1)?.trim() === '') fresh.pop();
  return fresh.join('\n');
}
