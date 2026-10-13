import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'USAGE',
  'NOT_FOUND',
  'NOT_CONNECTED',
  'APP_UNAVAILABLE',
  'INVALID_TOKEN',
  'VERSION_MISMATCH',
  'UNSUPPORTED',
  'PROMPT_FAILED',
  'INTERNAL',
  'CONFLICT',
  'NOT_REGENT',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export class OrqError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrqError';
  }
}

const EXIT_CODES: Record<ErrorCode, number> = {
  USAGE: 2,
  UNSUPPORTED: 2,
  NOT_FOUND: 3,
  NOT_CONNECTED: 3,
  APP_UNAVAILABLE: 4,
  VERSION_MISMATCH: 4,
  INVALID_TOKEN: 5,
  PROMPT_FAILED: 6,
  INTERNAL: 1,
  CONFLICT: 7,
  NOT_REGENT: 5,
};

export function exitCodeFor(code: ErrorCode): number {
  return EXIT_CODES[code];
}
