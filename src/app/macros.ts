/**
 * Actions (macros): record parametric operations from the command history and replay them.
 * Recordings store action ids + arguments (never pixel data), so they are portable, can be
 * exported as JSON and are the foundation for future scripting.
 */
import type { RecordedOp } from '../history/history';
import { editor } from './editor';
import { ui } from './store';
import { loadJSON, saveJSON } from './settings';
import { newId } from '../document/ids';

export interface MacroStep extends RecordedOp {
  label: string;
  enabled: boolean;
}

export interface Macro {
  id: string;
  name: string;
  steps: MacroStep[];
}

export interface ActionSet {
  id: string;
  name: string;
  macros: Macro[];
}

const KEY = 'celenne.actions.v1';

function defaults(): ActionSet[] {
  return [
    {
      id: 'set-default',
      name: 'Default Actions',
      macros: [
        { id: 'm-vignette', name: 'Soft Vignette (selection)', steps: [{ action: 'select.inverse', label: 'Inverse', enabled: true }, { action: 'select.modify', args: { kind: 'feather', amount: 60 }, label: 'Feather 60 px', enabled: true }, { action: 'edit.fill', args: { use: 'black', mode: 'multiply', opacity: 0.5, preserveTransparency: false }, label: 'Fill Black 50% Multiply', enabled: true }, { action: 'select.deselect', label: 'Deselect', enabled: true }] },
        { id: 'm-sharpen', name: 'Web Sharpen', steps: [{ action: 'filter.apply', args: { id: 'unsharpMask', params: { amount: 80, radius: 0.8, threshold: 2 } }, label: 'Unsharp Mask', enabled: true }] },
        { id: 'm-bw', name: 'Black & White Adjustment', steps: [{ action: 'layer.newAdjustment', args: { type: 'blackWhite' }, label: 'New Black & White Layer', enabled: true }] },
        { id: 'm-flatten', name: 'Flatten + 8-bit', steps: [{ action: 'image.flatten', label: 'Flatten Image', enabled: true }, { action: 'image.bitDepth', args: { depth: 8 }, label: '8 Bits/Channel', enabled: true }] },
      ],
    },
  ];
}

class MacroStore {
  sets: ActionSet[] = loadJSON<ActionSet[]>(KEY, defaults());
  recording: { setId: string; macroId: string } | null = null;
  playing = false;
  private listeners = new Set<() => void>();

  on(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private changed() {
    saveJSON(KEY, this.sets);
    for (const l of this.listeners) l();
  }

  macro(setId: string, macroId: string): Macro | undefined {
    return this.sets.find((s) => s.id === setId)?.macros.find((m) => m.id === macroId);
  }

  newSet(name = 'New Set'): ActionSet {
    const s = { id: newId('set'), name, macros: [] };
    this.sets.push(s);
    this.changed();
    return s;
  }

  newMacro(setId: string, name: string): Macro | null {
    const set = this.sets.find((s) => s.id === setId);
    if (!set) return null;
    const m = { id: newId('macro'), name, steps: [] };
    set.macros.push(m);
    this.changed();
    return m;
  }

  startRecording(setId: string, macroId: string): void {
    this.stopRecording();
    this.recording = { setId, macroId };
    const attach = () => {
      for (const s of editor.sessions)
        s.history.recorder = (op, label) => {
          const m = this.recording && this.macro(this.recording.setId, this.recording.macroId);
          if (!m || this.playing) return;
          m.steps.push({ ...structuredClone(op), label, enabled: true });
          this.changed();
        };
    };
    attach();
    this.unsubRecord = setInterval(attach, 500);
    ui.set({ recordingAction: macroId });
    this.changed();
  }
  private unsubRecord: ReturnType<typeof setInterval> | null = null;

  stopRecording(): void {
    if (this.unsubRecord) clearInterval(this.unsubRecord);
    this.unsubRecord = null;
    for (const s of editor.sessions) s.history.recorder = null;
    this.recording = null;
    ui.set({ recordingAction: null });
    this.changed();
  }

  async play(setId: string, macroId: string, fromStep = 0): Promise<void> {
    const m = this.macro(setId, macroId);
    if (!m) return;
    if (!editor.active) {
      ui.toast('info', 'Open a document to play an action.');
      return;
    }
    const { run } = await import('./actions');
    this.playing = true;
    try {
      for (const step of m.steps.slice(fromStep)) {
        if (!step.enabled) continue;
        await run(step.action, step.args);
      }
      ui.toast('success', `Action "${m.name}" finished.`, undefined, 2000);
    } catch (e) {
      ui.toast('error', `Action "${m.name}" stopped`, (e as Error).message);
    } finally {
      this.playing = false;
    }
  }

  deleteMacro(setId: string, macroId: string): void {
    const set = this.sets.find((s) => s.id === setId);
    if (!set) return;
    set.macros = set.macros.filter((m) => m.id !== macroId);
    this.changed();
  }

  deleteSet(setId: string): void {
    this.sets = this.sets.filter((s) => s.id !== setId);
    this.changed();
  }

  deleteStep(setId: string, macroId: string, index: number): void {
    const m = this.macro(setId, macroId);
    if (!m) return;
    m.steps.splice(index, 1);
    this.changed();
  }

  toggleStep(setId: string, macroId: string, index: number): void {
    const m = this.macro(setId, macroId);
    if (!m || !m.steps[index]) return;
    m.steps[index].enabled = !m.steps[index].enabled;
    this.changed();
  }

  rename(setId: string, macroId: string | null, name: string): void {
    const set = this.sets.find((s) => s.id === setId);
    if (!set) return;
    if (macroId) {
      const m = set.macros.find((x) => x.id === macroId);
      if (m) m.name = name;
    } else set.name = name;
    this.changed();
  }

  exportSet(setId: string): string {
    return JSON.stringify(this.sets.find((s) => s.id === setId), null, 2);
  }

  importSet(json: string): void {
    const s = JSON.parse(json) as ActionSet;
    if (!s || !Array.isArray(s.macros)) throw new Error('Not a Celenne action set');
    s.id = newId('set');
    for (const m of s.macros) {
      m.id = newId('macro');
      if (!Array.isArray(m.steps)) throw new Error('Invalid action set');
      for (const st of m.steps) if (typeof st.action !== 'string') throw new Error('Invalid action step');
    }
    this.sets.push(s);
    this.changed();
  }
}

export const macros = new MacroStore();
