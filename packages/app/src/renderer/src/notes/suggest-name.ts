export function suggestNoteName(existing: string[]): string {
  const taken = new Set(existing);
  for (let index = 1; ; index++) if (!taken.has(`nota-${index}`)) return `nota-${index}`;
}
