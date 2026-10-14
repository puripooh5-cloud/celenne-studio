/** View menu operations. */
import { hasCustomCmykProfile, workingCmykProfile } from '../colorSettings';
import { editor } from '../editor';
import { ui, useApp, ViewFlags } from '../store';
import { need } from './common';
import { LambdaCommand } from '../../commands/layerCommands';
import { newId } from '../../document/ids';
import type { Guide } from '../../document/types';
import { colorEngine } from '../../color/cms';

function viewport(): { w: number; h: number } {
  return editor.hostFactory?.()?.viewportSize() ?? { w: 1200, h: 800 };
}

export function zoomBy(dir: 1 | -1): void {
  const s = need();
  if (!s) return;
  const { w, h } = viewport();
  s.view.zoomStep(w / 2, h / 2, dir);
  editor.updateTitle();
  ui.bump('viewRev');
}

export function zoomTo(z: number): void {
  const s = need();
  if (!s) return;
  const { w, h } = viewport();
  s.view.setZoomCentered(z, w, h);
  editor.updateTitle();
  ui.bump('viewRev');
}

export function fitOnScreen(fill = false): void {
  const s = need();
  if (!s) return;
  const { w, h } = viewport();
  s.view.fit(s.doc.width, s.doc.height, w, h, fill, fill ? 0 : 24);
  editor.updateTitle();
  ui.bump('viewRev');
}

export function printSize(): void {
  const s = need();
  if (!s) return;
  // Screen assumed at 96 ppi (Windows default); print size = document ppi.
  zoomTo(96 / Math.max(1, s.doc.canvas.resolution));
}

export function rotateView(deg: number | null): void {
  const s = need();
  if (!s) return;
  const { w, h } = viewport();
  s.view.rotateAround(w / 2, h / 2, deg === null ? 0 : (deg * Math.PI) / 180);
  ui.bump('viewRev');
}

export function toggleView(flag: keyof ViewFlags): void {
  ui.set((s) => ({ view: { ...s.view, [flag]: !s.view[flag] } }));
  if (flag === 'proofColors' || flag === 'gamutWarning') updateProof();
  ui.bump('viewRev');
}

export async function updateProof(): Promise<void> {
  const st = useApp.getState();
  if (st.view.proofColors || st.view.gamutWarning) {
    await colorEngine.init();
    if (!hasCustomCmykProfile()) ui.toast('info', `Proofing with ${workingCmykProfile().name}.`, 'Load your printer’s or press’s CMYK profile in Preferences › Color Management for an accurate proof.');
  }
  for (const s of editor.sessions) s.engine.invalidateAll();
  ui.bump('viewRev');
}

export function addGuide(orientation: Guide['orientation'], position: number): void {
  const s = need();
  if (!s) return;
  const g: Guide = { id: newId('guide'), orientation, position };
  s.push(new LambdaCommand('New Guide', (d) => { d.guides.push(g); d.emit({ type: 'guides' }); }, (d) => { d.guides = d.guides.filter((x) => x.id !== g.id); d.emit({ type: 'guides' }); }, { action: 'view.newGuide', args: { orientation, position } }));
}

export interface GuideLayoutSpec {
  columns: { enabled: boolean; number: number; width: number | null; gutter: number };
  rows: { enabled: boolean; number: number; height: number | null; gutter: number };
  margin: { enabled: boolean; top: number; left: number; bottom: number; right: number };
  centerColumns: boolean;
  clearExisting: boolean;
}

/** Guide positions for View ▸ New Guide Layout (Photoshop semantics: each column/row gets a guide on both edges). */
export function guideLayoutPositions(spec: GuideLayoutSpec, width: number, height: number): { orientation: Guide['orientation']; position: number }[] {
  const out: { orientation: Guide['orientation']; position: number }[] = [];
  const m = spec.margin.enabled ? spec.margin : { top: 0, left: 0, bottom: 0, right: 0 };
  if (spec.margin.enabled) {
    out.push({ orientation: 'vertical', position: m.left }, { orientation: 'vertical', position: width - m.right });
    out.push({ orientation: 'horizontal', position: m.top }, { orientation: 'horizontal', position: height - m.bottom });
  }
  const axis = (n: number, size: number | null, gutter: number, start: number, avail: number, orientation: Guide['orientation'], center: boolean) => {
    n = Math.max(1, Math.min(1000, Math.round(n)));
    const cell = size ?? (avail - gutter * (n - 1)) / n;
    const total = cell * n + gutter * (n - 1);
    let p = start + (center || size === null ? (avail - total) / 2 : 0);
    for (let i = 0; i < n; i++) {
      out.push({ orientation, position: p }, { orientation, position: p + cell });
      p += cell + gutter;
    }
  };
  if (spec.columns.enabled) axis(spec.columns.number, spec.columns.width, spec.columns.gutter, m.left, width - m.left - m.right, 'vertical', spec.centerColumns);
  if (spec.rows.enabled) axis(spec.rows.number, spec.rows.height, spec.rows.gutter, m.top, height - m.top - m.bottom, 'horizontal', false);
  // De-duplicate (adjacent cells without a gutter share an edge).
  const seen = new Set<string>();
  return out.filter((g) => {
    const k = `${g.orientation}:${Math.round(g.position * 1000)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function addGuideLayout(spec: GuideLayoutSpec): void {
  const s = need();
  if (!s) return;
  const before = structuredClone(s.doc.guides);
  const added: Guide[] = guideLayoutPositions(spec, s.doc.width, s.doc.height).map((g) => ({ id: newId('guide'), ...g }));
  const after = [...(spec.clearExisting ? [] : before), ...added];
  s.push(new LambdaCommand('New Guide Layout', (d) => { d.guides = structuredClone(after); d.emit({ type: 'guides' }); }, (d) => { d.guides = structuredClone(before); d.emit({ type: 'guides' }); }, { action: 'view.newGuideLayout', args: spec as unknown as Record<string, unknown> }));
  if (!useApp.getState().view.guides) ui.set((st) => ({ view: { ...st.view, guides: true } }));
  ui.bump('viewRev');
}

export function moveGuide(id: string, position: number, before: number): void {
  const s = need();
  if (!s) return;
  s.push(new LambdaCommand('Move Guide', (d) => { const g = d.guideById(id); if (g) g.position = position; d.emit({ type: 'guides' }); }, (d) => { const g = d.guideById(id); if (g) g.position = before; d.emit({ type: 'guides' }); }));
}

export function removeGuide(id: string): void {
  const s = need();
  const g = s?.doc.guideById(id);
  if (!s || !g) return;
  const copy = { ...g };
  s.push(new LambdaCommand('Delete Guide', (d) => { d.guides = d.guides.filter((x) => x.id !== id); d.emit({ type: 'guides' }); }, (d) => { d.guides.push(copy); d.emit({ type: 'guides' }); }));
}

export function clearGuides(): void {
  const s = need();
  if (!s || !s.doc.guides.length) return;
  const before = structuredClone(s.doc.guides);
  s.push(new LambdaCommand('Clear Guides', (d) => { d.guides = []; d.emit({ type: 'guides' }); }, (d) => { d.guides = structuredClone(before); d.emit({ type: 'guides' }); }, { action: 'view.clearGuides' }));
}

export let guidesLocked = false;
export function toggleLockGuides(): void {
  guidesLocked = !guidesLocked;
  ui.bump('viewRev');
}
