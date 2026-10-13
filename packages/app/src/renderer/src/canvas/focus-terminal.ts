export function focusTerminalRequest(
  name: string,
  deps: {
    getNode(id: string): { position: { x: number; y: number }; measured?: { width?: number; height?: number } } | undefined;
    setCenter(x: number, y: number, opts: { zoom: number; duration: number }): unknown;
    setFocus(name: string | null): void;
    sizeOf(name: string): { width: number; height: number } | undefined;
  },
): boolean {
  const node = deps.getNode(name);
  if (!node) return false;
  const size = deps.sizeOf(name);
  const width = node.measured?.width ?? size?.width ?? 0;
  const height = node.measured?.height ?? size?.height ?? 0;
  deps.setFocus(name);
  void deps.setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: 1, duration: 200 });
  return true;
}
