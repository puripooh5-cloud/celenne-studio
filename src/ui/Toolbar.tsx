/** Left toolbar with flyout tool groups and color chips. */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp, ui } from '../app/store';
import { editor } from '../app/editor';
import { TOOL_GROUP_ORDER, TOOLS, ToolId } from '../tools/toolTypes';
import { Icon } from './icons';
import { keymap } from '../app/shortcuts';
import { rgbCss } from '../color/convert';
import { run } from '../app/actions';

export function Toolbar() {
  const tool = useApp((s) => s.tool);
  const groupTool = useApp((s) => s.groupTool);
  const fg = useApp((s) => s.fg);
  const bg = useApp((s) => s.bg);
  const quickMask = useApp((s) => s.quickMask);
  const [flyout, setFlyout] = useState<{ group: string; x: number; y: number } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const groups = TOOL_GROUP_ORDER.map((g) => TOOLS.filter((t) => t.group === g));
  const shown = (group: string): ToolId => {
    const inGroup = TOOLS.filter((t) => t.group === group);
    if (inGroup.some((t) => t.id === tool)) return tool;
    return groupTool[group] ?? inGroup[0].id;
  };
  const openFlyout = (group: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setFlyout({ group, x: r.right + 4, y: r.top });
  };
  const sepAfter = new Set(['wand', 'eyedropper', 'gradient', 'dodge', 'shape']);
  return (
    <div className="toolbar" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      {groups.map((items) => {
        const g = items[0].group;
        const id = shown(g);
        const info = TOOLS.find((t) => t.id === id)!;
        const key = keymap.bindingsFor(`tool:${id}`)[0];
        return (
          <div key={g} style={{ display: 'contents' }}>
            <button
              className={`tool-btn${items.some((t) => t.id === tool) ? ' active' : ''}`}
              title={`${info.label}${key ? ` (${key})` : ''}${info.comingSoon ? ' — Coming Soon' : ''}`}
              aria-label={info.label}
              aria-pressed={items.some((t) => t.id === tool)}
              onPointerDown={(e) => {
                const el = e.currentTarget;
                if (items.length > 1) holdTimer.current = setTimeout(() => openFlyout(g, el), 380);
              }}
              onPointerUp={() => {
                if (holdTimer.current) clearTimeout(holdTimer.current);
              }}
              onClick={() => editor.setTool(id)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (items.length > 1) openFlyout(g, e.currentTarget);
              }}
            >
              <Icon name={id} />
              {items.length > 1 && <span className="flyout-mark" />}
            </button>
            {sepAfter.has(g) && <div className="sep" />}
          </div>
        );
      })}
      <div className="sep" />
      <div className="color-chips">
        <div className="chip bg" style={{ background: rgbCss(bg) }} title="Background color" onClick={() => ui.openDialog('colorPicker', { purpose: 'background' })} />
        <div className="chip fg" style={{ background: rgbCss(fg) }} title="Foreground color" onClick={() => ui.openDialog('colorPicker', { purpose: 'foreground' })} />
      </div>
      <div className="row" style={{ gap: 2 }}>
        <button className="icon-btn" title="Default colors (D)" onClick={() => ui.set({ fg: { r: 0, g: 0, b: 0 }, bg: { r: 1, g: 1, b: 1 } })}>
          <Icon name="reset" size={13} />
        </button>
        <button className="icon-btn" title="Swap colors (X)" onClick={() => ui.set((s) => ({ fg: s.bg, bg: s.fg }))}>
          <Icon name="swap" size={13} />
        </button>
      </div>
      <button className={`tool-btn${quickMask ? ' active' : ''}`} title="Edit in Quick Mask Mode (Q)" onClick={() => run('select.quickMask')}>
        <Icon name="mask" />
      </button>
      {flyout &&
        createPortal(
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 899 }} onMouseDown={() => setFlyout(null)} />
            <div className="flyout" style={{ left: flyout.x, top: flyout.y }} role="menu">
              {TOOLS.filter((t) => t.group === flyout.group).map((t) => (
                <div
                  key={t.id}
                  className={`menu-item${t.id === tool ? ' active' : ''}`}
                  role="menuitem"
                  onClick={() => {
                    setFlyout(null);
                    editor.setTool(t.id);
                  }}
                >
                  <span className="check">{t.id === tool ? '■' : ''}</span>
                  <Icon name={t.id} />
                  <span className="label">{t.label}</span>
                  {t.comingSoon && <span className="soon">Coming Soon</span>}
                  {t.shortcut && <span className="kbd">{t.shortcut}</span>}
                </div>
              ))}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
