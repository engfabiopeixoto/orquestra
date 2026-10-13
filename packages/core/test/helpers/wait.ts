export async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condição não foi atingida no prazo.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
