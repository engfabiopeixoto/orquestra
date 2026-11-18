import { remoteDeviceSchema, type RemoteDevice } from '@orquestra/shared/remote';
import { z } from 'zod';

const AUTH_STORAGE_KEY = 'orquestra.mobile.auth';

const storedAuthSchema = z.object({ token: z.string().min(1), device: remoteDeviceSchema });

export type StoredAuth = {
  token: string;
  device: RemoteDevice;
};

export function loadStoredAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = storedAuthSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveStoredAuth(auth: StoredAuth): void {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth));
}

export function clearStoredAuth(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}
