/** Modal dialog frame (draggable, Esc/Enter aware, focus-trapped). */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton } from '../controls';

export function Modal({ title, children, onClose, onOk, okLabel = 'OK', footerLeft, width, okDisabled, noFooter }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onOk?: () => void;
  okLabel?: string;
  footerLeft?: ReactNode;
  width?: number;
  okDisabled?: boolean;
  noFooter?: boolean;
}) {
  const [off, setOff] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('input, select, textarea, button.primary');
    first?.focus();
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    if (e.key === 'Enter' && onOk && !okDisabled && (e.target as HTMLElement).tagName !== 'TEXTAREA' && (e.target as HTMLElement).tagName !== 'BUTTON') { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); setTimeout(onOk, 0); }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={onKey}>
      <div className="modal" ref={ref} role="dialog" aria-modal="true" aria-label={title} style={{ width, transform: `translate(${off.x}px, ${off.y}px)` }}>
        <div
          className="modal-head"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            const sx = e.clientX - off.x, sy = e.clientY - off.y;
            const el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            const mv = (ev: PointerEvent) => setOff({ x: ev.clientX - sx, y: ev.clientY - sy });
            const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
            el.addEventListener('pointermove', mv);
            el.addEventListener('pointerup', up);
          }}
        >
          {title}
          <span className="x"><IconButton icon="close" title="Close" onClick={onClose} /></span>
        </div>
        <div className="modal-body">{children}</div>
        {!noFooter && (
          <div className="modal-foot">
            <div className="left">{footerLeft}</div>
            <button className="btn" onClick={onClose}>Cancel</button>
            {onOk && <button className="btn primary" disabled={okDisabled} onClick={onOk}>{okLabel}</button>}
          </div>
        )}
      </div>
    </div>
  );
}
