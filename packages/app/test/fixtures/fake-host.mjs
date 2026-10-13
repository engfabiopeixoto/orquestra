// Núcleo falso para os testes do principal: fala o protocolo sem abrir terminais.
if (process.env.FAKE_HOST_EXIT_EARLY) process.exit(7);
process.on('message', (message) => {
  if (message.kind === 'shutdown') {
    if (process.env.FAKE_HOST_HANG) return;
    process.exit(0);
  }
  if (message.kind === 'confirm-reply') {
    process.send({ kind: 'event', event: { type: 'notice', level: 'info', message: `confirmado:${message.approved}` } });
    return;
  }
  if (message.kind !== 'command') return;
  if (message.method === 'project.open') process.send({ kind: 'response', id: message.id, ok: true, result: { dir: message.params.dir, name: 'p', terminals: [], notes: [], edges: [], layout: {}, viewport: { x: 0, y: 0, zoom: 1 } } });
  if (message.method === 'edge.connect') process.send({ kind: 'response-error', id: message.id, error: { code: 'NOT_FOUND', message: 'X não existe.' } });
  if (message.method === 'project.close') {
    process.send({ kind: 'confirm', id: 'c1', message: 'pode?' });
    process.send({ kind: 'response', id: message.id, ok: true, result: {} });
  }
  if (message.method === 'terminal.remove') process.exit(3);
});
if (!process.env.FAKE_HOST_SILENT) process.send({ kind: 'ready' });
setInterval(() => {}, 1000);
