let active: string | undefined;
let generation = 0;
export const activeWorkspaceId = () => active;
export const workspaceGeneration = () => generation;
export function setActiveWorkspace(id: string | undefined): void {
  active = id;
  generation++;
}
export const outputKey = (name: string, workspaceId = active) => workspaceId ? `${workspaceId}\u0000${name}` : name;
