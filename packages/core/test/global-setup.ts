import { buildCli } from '../../cli/build.js';

export async function setup(): Promise<void> {
  await buildCli();
}
