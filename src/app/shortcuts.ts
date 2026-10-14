/**
 * Keyboard shortcuts: default bindings come from the action registry and tool list; users can
 * override any binding (persisted). Tool keys cycle through a flyout group with Shift.
 */
import { allActions } from './actions';
import { TOOLS, ToolId } from '../tools/toolTypes';
import { loadJSON, saveJSON } from './settings';

const KEY = 'celenne.shortcuts.v1';

/** Normalized chord like "Ctrl+Shift+S" (Mod order: Ctrl, Alt, Shift). "Ctrl" means Cmd on macOS. */
export function chordFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k === '+') k = '=';
  else if (k.length === 1) k = k.toUpperCase();
  // Shifted punctuation: use the base key via code where possible.
  if (e.shiftKey && /^Digit\d$/.test(e.code)) k = e.code.slice(5);
  if (e.code === 'BracketLeft') k = '[';
  if (e.code === 'BracketRight') k = ']';
  if (e.code === 'Backslash') k = '\\';
  if (e.code === 'Semicolon') k = ';';
  if (e.code === 'Quote') k = "'";
  if (e.code === 'Comma') k = ',';
  if (e.code === 'Period') k = '.';
  if (e.code === 'Slash') k = '/';
  if (e.code === 'Minus') k = '-';
  if (e.code === 'Equal') k = '=';
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(k)) return parts.join('+');
  parts.push(k);
  return parts.join('+');
}

export function normalizeChord(c: string): string {
  const parts = c.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  const mods = ['Ctrl', 'Alt', 'Shift'].filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase() || (m === 'Ctrl' && /^(cmd|meta|command)$/i.test(p))));
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
}

type Overrides = Record<string, string[]>;

class Keymap {
  private overrides: Overrides = loadJSON<Overrides>(KEY, {});
  private map = new Map<string, string>();
  private listeners = new Set<() => void>();

  constructor() {
    this.rebuild();
  }

  on(l: () => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  /** Bindings for an id ("tool:<id>" for tools). */
  bindingsFor(id: string): string[] {
    if (this.overrides[id]) return this.overrides[id];
    if (id.startsWith('tool:')) {
      const t = TOOLS.find((x) => `tool:${x.id}` === id);
      return t?.shortcut ? [t.shortcut] : [];
    }
    const a = allActions().find((x) => x.id === id);
    return a?.shortcut ? [a.shortcut] : [];
  }

  rebuild(): void {
    this.map.clear();
    const ids = [...allActions().map((a) => a.id), ...TOOLS.map((t) => `tool:${t.id}`)];
    for (const id of ids) {
      for (const c of this.bindingsFor(id)) {
        const n = normalizeChord(c);
        // Tool letters are shared by a group; the first tool of the group owns the key.
        if (this.map.has(n) && id.startsWith('tool:')) continue;
        if (!this.map.has(n)) this.map.set(n, id);
      }
    }
    for (const l of this.listeners) l();
  }

  lookup(chord: string): string | undefined {
    return this.map.get(normalizeChord(chord));
  }

  /** Returns the id currently bound to a chord (for conflict warnings). */
  conflict(chord: string, exceptId: string): string | undefined {
    const id = this.lookup(chord);
    return id && id !== exceptId ? id : undefined;
  }

  set(id: string, chords: string[]): void {
    this.overrides[id] = chords.map(normalizeChord);
    saveJSON(KEY, this.overrides);
    this.rebuild();
  }

  reset(id?: string): void {
    if (id) delete this.overrides[id];
    else this.overrides = {};
    saveJSON(KEY, this.overrides);
    this.rebuild();
  }

  exportJSON(): string {
    return JSON.stringify(this.overrides, null, 2);
  }

  importJSON(json: string): void {
    const o = JSON.parse(json);
    if (typeof o !== 'object' || !o) throw new Error('Invalid shortcut file');
    this.overrides = o;
    saveJSON(KEY, o);
    this.rebuild();
  }
}

export const keymap = new Keymap();

/** Next tool in the flyout group (Shift+tool key cycles). */
export function cycleTool(current: ToolId, key: string): ToolId | null {
  const group = TOOLS.filter((t) => t.shortcut?.toUpperCase() === key.toUpperCase() && !t.comingSoon);
  if (!group.length) return null;
  const i = group.findIndex((t) => t.id === current);
  return group[(i + 1) % group.length].id;
}
