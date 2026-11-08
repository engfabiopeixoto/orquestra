// Agente falso para o e2e da tag de modelo: mostra os argumentos e responde ao /model como o Claude Code.
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdout.write(`agente falso ${process.argv.slice(2).filter((arg) => !arg.endsWith('.json')).join(' ')}\r\n> `);
let line = '';
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    if (char !== '\r') { line += char; process.stdout.write(char); continue; }
    const model = /^\/model (\S+)$/.exec(line.trim())?.[1];
    process.stdout.write(model ? `\r\nSet model to ${model}\r\n> ` : '\r\n> ');
    line = '';
  }
});
