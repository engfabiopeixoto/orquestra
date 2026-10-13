import { useEffect } from 'react';
import { appStore, useApp } from '../store';

const AUTO_DISMISS_MS = 6000;

export function NoticeList() {
  const notices = useApp((state) => state.notices);
  useEffect(() => {
    const timers = notices
      .filter((notice) => notice.level === 'info')
      .map((notice) => setTimeout(() => appStore.getState().dismissNotice(notice.id), AUTO_DISMISS_MS));
    return () => timers.forEach(clearTimeout);
  }, [notices]);
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
