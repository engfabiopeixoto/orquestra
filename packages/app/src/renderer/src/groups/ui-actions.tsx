import { createContext, useContext } from 'react';

export type GroupUIActions = {
  edit(id: string, focus?: 'title' | 'color'): void;
  members(id: string): void;
  newTerminal(id: string): void;
  newNote(id: string): void;
};
export const GroupUIContext = createContext<GroupUIActions | null>(null);
export function useGroupUI(): GroupUIActions {
  const actions = useContext(GroupUIContext);
  if (!actions) throw new Error('Ações de grupo indisponíveis.');
  return actions;
}
