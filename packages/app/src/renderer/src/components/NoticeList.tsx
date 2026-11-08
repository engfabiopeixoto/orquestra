import { useEffect, useRef } from 'react';
import { appStore, useApp } from '../store';

/** Todo aviso some sozinho depois deste tempo; o × fecha antes. */
export const AUTO_DISMISS_MS = 10000;

export function NoticeList() {
  const notices = useApp((state) => state.notices);
  // Um timer por aviso, criado quando ele aparece: avisos novos não reiniciam o tempo dos anteriores.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const current = new Set(notices.map((notice) => notice.id));
    for (const [id, timer] of timers.current) {
      if (current.has(id)) continue;
      clearTimeout(timer);
      timers.current.delete(id);
    }
    for (const notice of notices) {
      if (timers.current.has(notice.id)) continue;
      timers.current.set(notice.id, setTimeout(() => appStore.getState().dismissNotice(notice.id), AUTO_DISMISS_MS));
    }
  }, [notices]);
  useEffect(() => {
    const pending = timers.current;
    return () => { for (const timer of pending.values()) clearTimeout(timer); pending.clear(); };
  }, []);
  return (
    <div className="notices">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice notice-${notice.level}`}>
          <span>{notice.message}</span>
          <button aria-label="Fechar aviso" onClick={() => appStore.getState().dismissNotice(notice.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
