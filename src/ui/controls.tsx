/** Reusable form controls. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { rgbCss } from '../color/convert';
import type { RGB } from '../color/types';
import { BLEND_MODES, BlendMode, LAYER_BLEND_MODES } from '../image-engine/blend';
import { Icon } from './icons';

/** Safe evaluator for + - * / and parentheses (no eval). Returns NaN on invalid input. */
export function evalArithmetic(src: string): number {
  const t = src.replace(/\s+/g, '');
  let i = 0;
  const num = (): number => {
    if (t[i] === '(') {
      i++;
      const v = expr();
      if (t[i] !== ')') return NaN;
      i++;
      return v;
    }
    if (t[i] === '-') { i++; return -num(); }
    const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(t.slice(i));
    if (!m) return NaN;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const term = (): number => {
    let v = num();
    while (t[i] === '*' || t[i] === '/') {
      const op = t[i++];
      const r = num();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (t[i] === '+' || t[i] === '-') {
      const op = t[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = expr();
  return i === t.length ? v : NaN;
}

export function NumberField({ label, value, onChange, onCommit, min = -Infinity, max = Infinity, step = 1, unit, width = 58, precision, title, disabled }: {
  label?: string;
  value: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  width?: number;
  precision?: number;
  title?: string;
  disabled?: boolean;
}) {
  const fmt = (v: number) => {
    const p = precision ?? (step < 1 ? Math.min(3, Math.ceil(-Math.log10(step))) : 0);
    return Number.isFinite(v) ? v.toFixed(p).replace(/\.0+$/, '') : '';
  };
  const [text, setText] = useState(fmt(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(value));
  }, [value]);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const commitText = () => {
    // Allow simple arithmetic ("100*2", "50+10").
    let v = Number(text);
    if (!Number.isFinite(v)) v = evalArithmetic(text);
    if (Number.isFinite(v)) onChange(clamp(v));
    else setText(fmt(value));
    onCommit?.();
  };
  const scrub = (e: React.PointerEvent) => {
    if (disabled) return;
    const startX = e.clientX, start = value;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => {
      const k = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      onChange(clamp(Math.round((start + ((ev.clientX - startX) / 2) * step * k) / step) * step));
    };
    const up = () => {
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      onCommit?.();
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
  };
  return (
    <label className="field" title={title}>
      {label && <span className="lbl scrub" onPointerDown={scrub}>{label}</span>}
      <input
        className="num"
        style={{ width }}
        value={text}
        disabled={disabled}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commitText();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const k = (e.shiftKey ? 10 : 1) * step * (e.key === 'ArrowUp' ? 1 : -1);
            const v = clamp(value + k);
            onChange(v);
            setText(fmt(v));
          }
        }}
      />
      {unit && <span className="faint">{unit}</span>}
    </label>
  );
}

export function Slider({ label, value, onChange, onCommit, min = 0, max = 100, step = 1, unit, showNumber = true, width }: {
  label?: string;
  value: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  showNumber?: boolean;
  width?: number;
}) {
  return (
    <div className="field" style={{ width }}>
      {label && <span className="lbl" style={{ minWidth: 64 }}>{label}</span>}
      <input
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={() => onCommit?.()}
        onKeyUp={() => onCommit?.()}
        aria-label={label}
      />
      {showNumber && <NumberField value={value} onChange={onChange} onCommit={onCommit} min={min} max={max} step={step} unit={unit} width={52} />}
    </div>
  );
}

export function Select<T extends string>({ label, value, options, onChange, title, width }: { label?: string; value: T; options: { value: T; label: string; disabled?: boolean }[]; onChange: (v: T) => void; title?: string; width?: number }) {
  return (
    <label className="field" title={title}>
      {label && <span className="lbl">{label}</span>}
      <select className="sel" style={{ width }} value={value} onChange={(e) => onChange(e.target.value as T)} onKeyDown={(e) => e.stopPropagation()}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Check({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="chk" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label?: string; icon?: string; title: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} title={o.title} aria-label={o.title} aria-checked={o.value === value} role="radio" onClick={() => onChange(o.value)}>
          {o.icon ? <Icon name={o.icon} /> : o.label}
        </button>
      ))}
    </div>
  );
}

export function ColorSwatch({ color, alpha = 1, onClick, title, size = 22 }: { color: RGB; alpha?: number; onClick?: () => void; title?: string; size?: number }) {
  return (
    <button className="swatch" style={{ width: size, height: size }} title={title} aria-label={title} onClick={onClick}>
      <i style={{ background: rgbCss(color, alpha) }} />
    </button>
  );
}

export function BlendSelect({ value, onChange, allowPassThrough = false, width }: { value: BlendMode; onChange: (m: BlendMode) => void; allowPassThrough?: boolean; width?: number }) {
  const modes = allowPassThrough ? BLEND_MODES : LAYER_BLEND_MODES;
  return (
    <select className="sel" style={{ width }} value={value} onChange={(e) => onChange(e.target.value as BlendMode)} onKeyDown={(e) => e.stopPropagation()} aria-label="Blend mode">
      {modes.flatMap((m, i) => [
        ...(i > 0 && modes[i - 1].group !== m.group ? [<option key={`sep-${m.id}`} disabled>──────────</option>] : []),
        <option key={m.id} value={m.id}>
          {m.label}
        </option>,
      ])}
    </select>
  );
}

export function IconButton({ icon, title, onClick, disabled, on }: { icon: string; title: string; onClick?: (e: React.MouseEvent) => void; disabled?: boolean; on?: boolean }) {
  return (
    <button className={`icon-btn${on ? ' on' : ''}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </button>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="section-title">{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}
