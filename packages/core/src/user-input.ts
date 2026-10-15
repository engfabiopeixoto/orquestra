/** Remove relatórios de interface enviados ao terminal, mas que não representam teclas do usuário. */
export function keyboardInput(data: string): string {
  return data
    .replace(/\x1b\[(?:I|O)/g, '')
    .replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '')
    .replace(/\x1b\[M[\s\S]{3}/g, '');
}

/** Indica se a entrada contém algo que o usuário digitou, ignorando foco e relatórios do mouse. */
export function hasUserKeystroke(data: string): boolean {
  return keyboardInput(data).length > 0;
}
