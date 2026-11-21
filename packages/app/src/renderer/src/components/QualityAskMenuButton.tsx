import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortalOverlay } from '../portal/modal-overlay';

export type QualityAgentTerminal = {
  name: string;
  agent: string;
  state?: string;
  unloaded?: boolean;
};

/** Botão que abre menu flutuante de seleção de agente elegível protegido por usePortalOverlay. */
export function QualityAskMenuButton({
  label,
  className,
  title,
  ariaLabel,
  menuAriaLabel,
  terminals,
  open,
  onOpenChange,
  onSelectTerminal,
}: {
  label: string;
  className: string;
  title?: string;
  ariaLabel?: string;
  menuAriaLabel: string;
  terminals: QualityAgentTerminal[];
  open?: boolean;
  onOpenChange?(open: boolean): void;
  onSelectTerminal(terminalName: string): void;
}) {
  const [localPos, setLocalPos] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const eligibleTerminals = terminals.filter((t) => t.agent !== 'shell' && !t.unloaded && t.state !== 'exited');
  const isControlled = open !== undefined;
  const active = isControlled ? open : localPos !== null;
  const menuOpen = active && eligibleTerminals.length > 0;
  const menuPos = menuOpen ? localPos : null;
  usePortalOverlay(menuOpen);

  const setMenuOpen = (nextOpen: boolean, pos: { left: number; top: number } | null = null) => {
    setLocalPos(nextOpen ? pos : null);
    onOpenChange?.(nextOpen);
  };

  useEffect(() => {
    if (active && eligibleTerminals.length === 0) setMenuOpen(false);
  }, [active, eligibleTerminals.length]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const toggleMenu = () => {
    if (active) {
      setMenuOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    setMenuOpen(true, {
      left: Math.min(rect?.left ?? 10, Math.max(8, window.innerWidth - 220)),
      top: Math.min((rect?.bottom ?? 80) + 4, Math.max(8, window.innerHeight - 140)),
    });
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        disabled={eligibleTerminals.length === 0}
        title={eligibleTerminals.length === 0 ? 'Abra um terminal de agente' : title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={toggleMenu}
      >
        {label}
      </button>

      {menuOpen && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              className="ctx ctx-menu quality-agent-menu"
              role="menu"
              aria-label={menuAriaLabel}
              style={{ position: 'fixed', left: menuPos.left, top: menuPos.top }}
            >
              {eligibleTerminals.map((terminal) => (
                <button
                  key={terminal.name}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onSelectTerminal(terminal.name);
                  }}
                >
                  {`${terminal.name} (${terminal.agent})`}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
