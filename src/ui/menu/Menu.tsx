/** Popup menus: application menu bar, context menus and submenus (keyboard navigable). */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MENUS, MenuItem } from '../../app/menus';
import { action, run } from '../../app/actions';
import { keymap } from '../../app/shortcuts';
import { useApp } from '../../app/store';

export type PopupItem =
  | { type: 'item'; label: string; run: () => void; shortcut?: string; checked?: boolean; disabled?: boolean; soon?: boolean }
  | { type: 'separator' }
  | { type: 'submenu'; label: string; items: PopupItem[]; disabled?: boolean };

function resolve(items: MenuItem[] | (() => MenuItem[])): PopupItem[] {
  const list = typeof items === 'function' ? items() : items;
  return list.map((m): PopupItem => {
    if (m.type === 'separator') return { type: 'separator' };
    if (m.type === 'submenu') return { type: 'submenu', label: m.label, items: resolve(m.items) };
    if (m.type === 'custom') return { type: 'item', label: m.label, run: m.run, checked: m.checked?.(), disabled: m.enabled ? !m.enabled() : false };
    const a = action(m.id);
    if (!a) return { type: 'item', label: `${m.label ?? m.id} (missing)`, run: () => {}, disabled: true };
    const binding = keymap.bindingsFor(a.id)[0];
    return {
      type: 'item',
      label: m.label ?? a.label,
      run: () => run(a.id, m.args),
      shortcut: binding,
      checked: a.checked?.(),
      disabled: !a.comingSoon && a.enabled ? !a.enabled() : false,
      soon: a.comingSoon,
    };
  });
}

export function PopupMenu({ items, x, y, onClose, parentWidth = 0 }: { items: PopupItem[]; x: number; y: number; onClose: () => void; parentWidth?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(-1);
  const [openSub, setOpenSub] = useState<{ index: number; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x, ny = y;
    if (nx + r.width > window.innerWidth - 4) nx = parentWidth ? x - r.width - parentWidth : window.innerWidth - r.width - 4;
    if (ny + r.height > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ x: Math.max(4, nx), y: ny });
  }, [x, y, parentWidth]);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const activate = (i: number, el?: HTMLElement) => {
    const it = items[i];
    if (!it || it.type === 'separator') return;
    if (it.type === 'submenu') {
      if (it.disabled) return;
      const r = el?.getBoundingClientRect() ?? ref.current!.children[i].getBoundingClientRect();
      setOpenSub({ index: i, x: r.right, y: r.top - 4 });
      return;
    }
    if (it.disabled) return;
    onClose();
    it.run();
  };
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const selectable = items.map((it, i) => (it.type !== 'separator' && !('disabled' in it && it.disabled) ? i : -1)).filter((i) => i >= 0);
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(selectable[(selectable.indexOf(active) + 1) % selectable.length] ?? -1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(selectable[(selectable.indexOf(active) - 1 + selectable.length) % selectable.length] ?? -1); }
    else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); if (active >= 0) activate(active); }
    else if (e.key === 'Escape' || e.key === 'ArrowLeft') { e.preventDefault(); onClose(); }
  };
  return (
    <div className="menu-popup" ref={ref} style={{ left: pos.x, top: pos.y }} tabIndex={-1} onKeyDown={onKey} role="menu" onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it, i) => {
        if (it.type === 'separator') return <div key={i} className="menu-sep" role="separator" />;
        const disabled = 'disabled' in it && it.disabled;
        return (
          <div
            key={i}
            role="menuitem"
            aria-disabled={disabled}
            className={`menu-item${disabled ? ' disabled' : ''}${active === i || openSub?.index === i ? ' active' : ''}`}
            onMouseEnter={(e) => {
              setActive(i);
              if (it.type === 'submenu') activate(i, e.currentTarget);
              else setOpenSub(null);
            }}
            onClick={(e) => activate(i, e.currentTarget)}
          >
            <span className="check">{it.type === 'item' && it.checked ? '✓' : ''}</span>
            <span className="label">{it.label}</span>
            {it.type === 'item' && it.soon && <span className="soon">Coming Soon</span>}
            {it.type === 'item' && it.shortcut && <span className="kbd">{it.shortcut}</span>}
            {it.type === 'submenu' && <span className="arrow">›</span>}
          </div>
        );
      })}
      {openSub && items[openSub.index]?.type === 'submenu' && (
        <PopupMenu items={(items[openSub.index] as { items: PopupItem[] }).items} x={openSub.x} y={openSub.y} parentWidth={ref.current?.getBoundingClientRect().width ?? 0} onClose={onClose} />
      )}
    </div>
  );
}

/** Imperative context menu host. */
let showContext: ((items: PopupItem[], x: number, y: number) => void) | null = null;
export function openContextMenu(items: PopupItem[], x: number, y: number): void {
  showContext?.(items, x, y);
}

export function ContextMenuHost() {
  const [menu, setMenu] = useState<{ items: PopupItem[]; x: number; y: number } | null>(null);
  useEffect(() => {
    showContext = (items, x, y) => setMenu({ items, x, y });
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    return () => {
      showContext = null;
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
    };
  }, []);
  if (!menu) return null;
  return createPortal(<PopupMenu items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />, document.body);
}

export function MenuBar() {
  const [open, setOpen] = useState<{ id: string; x: number; y: number } | null>(null);
  useApp((s) => s.docRev);
  useApp((s) => s.historyRev);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const menu = open ? MENUS.find((m) => m.id === open.id) : null;
  return (
    <div className="menubar" role="menubar">
      <div className="logo" title="Celenne Studio" />
      {MENUS.map((m) => (
        <div
          key={m.id}
          role="menuitem"
          tabIndex={0}
          className={`menu-title${open?.id === m.id ? ' open' : ''}`}
          onMouseDown={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setOpen(open?.id === m.id ? null : { id: m.id, x: r.left, y: r.bottom + 2 });
          }}
          onMouseEnter={(e) => {
            if (open && open.id !== m.id) {
              const r = e.currentTarget.getBoundingClientRect();
              setOpen({ id: m.id, x: r.left, y: r.bottom + 2 });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'ArrowDown') {
              const r = e.currentTarget.getBoundingClientRect();
              setOpen({ id: m.id, x: r.left, y: r.bottom + 2 });
            }
          }}
        >
          {m.label}
        </div>
      ))}
      <div className="spacer" />
      <div className="search" onMouseDown={(e) => { e.stopPropagation(); run('edit.commandPalette'); }} title="Search commands (Ctrl+F)">
        ⌕ Search commands
      </div>
      {menu && open && createPortal(<PopupMenu key={menu.id} items={resolve(menu.items)} x={open.x} y={open.y} onClose={() => setOpen(null)} />, document.body)}
    </div>
  );
}
