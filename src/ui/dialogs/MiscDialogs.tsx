/**
 * Application dialogs: Preferences, Keyboard Shortcuts, About, File Info, Document Properties,
 * Missing Fonts, Recovered Documents, Assign/Convert Profile, Export As, PSD Compatibility Matrix,
 * Document Compatibility Report, GPU Information, Plugins and the Command Palette.
 */
import { currentGpu, gpuError, webgpuAvailable } from '../../gpu/device';
import { workingCmykProfile } from '../../app/colorSettings';
import { scratchAvailable, scratchStats } from '../../history/scratch';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Check, NumberField, Select, Slider, ColorSwatch } from '../controls';
import { editor } from '../../app/editor';
import { ui } from '../../app/store';
import { DEFAULT_PREFERENCES, Preferences } from '../../app/settings';
import { platform } from '../../app/platform/platform';
import type { RecoveryEntry } from '../../app/platform/platform';
import { allActions, run } from '../../app/actions';
import { chordFromEvent, keymap, normalizeChord } from '../../app/shortcuts';
import { TOOLS } from '../../tools/toolTypes';
import { exportAs, openBytes } from '../../app/fileOps';
import { exporters, exportModeNote } from '../../formats/registry';
import { BUILTIN_PROFILES, BuiltinProfileId, parseIccInfo } from '../../color/icc';
import { colorEngine } from '../../color/cms';
import type { Intent } from '../../color/cms';
import { assignProfile, convertToProfile } from '../../app/ops/imageOps';
import { COMPATIBILITY, Level } from '../../psd/compatibility';
import type { ColorProfileRef, DocumentMetadata, TextLayer } from '../../document/types';
import { hasRaster } from '../../document/types';
import { LambdaCommand } from '../../commands/layerCommands';
import { recordStateChange } from '../../history/history';
import { fonts } from '../../typography/fonts';
import { updateAppearance } from '../../layers/appearance';
import { plugins, PluginPackage } from '../../plugins/pluginHost';
import { SAMPLE_PLUGIN } from '../../plugins/samplePlugin';
import { providers } from '../../ai/provider';
import { UpdatePrivacyPrefs } from './UpdateDialogs';

const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => { const bin = atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };
const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;

async function pickFile(name: string, extensions: string[]): Promise<{ name: string; data: Uint8Array } | null> {
  const f = await platform().openFiles([{ name, extensions }], false);
  return f[0] ?? null;
}

async function saveText(defaultName: string, text: string, ext: string) {
  const path = await platform().chooseSavePath(defaultName, [{ name: ext.toUpperCase(), extensions: [ext] }]);
  if (path) await platform().writePath(path, new TextEncoder().encode(text));
}

// =============================================================================================
// Preferences
// =============================================================================================
type PrefTab = 'general' | 'performance' | 'scratch' | 'color' | 'guides' | 'ai' | 'updates';

export function PreferencesDialog({ close, tab: initialTab }: { close: () => void; tab?: PrefTab }) {
  const [p, setP] = useState<Preferences>(() => structuredClone(editor.prefs));
  const [tab, setTab] = useState<PrefTab>(initialTab ?? 'general');
  const [mem, setMem] = useState<{ totalBytes: number; freeBytes: number } | null>(null);
  const [scratchLoc, setScratchLoc] = useState<string>('');
  useEffect(() => {
    platform().memory().then(setMem).catch(() => {});
    platform().scratch.location().then(setScratchLoc).catch(() => {});
  }, []);
  const upd = <K extends keyof Preferences>(k: K, patch: Partial<Preferences[K]>) => setP((o) => ({ ...o, [k]: { ...o[k], ...patch } }));
  const ok = async () => {
    const prev = editor.prefs;
    const b = platform().bridge;
    if (b && p.scratch.directory !== prev.scratch.directory && p.scratch.directory) {
      try { await b.setScratchDir(p.scratch.directory); } catch (e) { ui.toast('error', 'Could not use that scratch disk', (e as Error).message); return; }
    }
    editor.setPrefs(p);
    document.documentElement.style.setProperty('--ui-scale', String(p.general.largeUI ? Math.max(p.general.uiScale, 1.25) : p.general.uiScale));
    if (prev.performance.gpuAcceleration !== p.performance.gpuAcceleration || prev.performance.renderer !== p.performance.renderer || prev.performance.gpuCompositing !== p.performance.gpuCompositing) ui.toast('info', 'GPU setting changes apply after restarting Celenne Studio.');
    close();
  };
  const proofInfo = p.color.proofProfile ? parseIccInfo(unb64(p.color.proofProfile)) : null;
  const tabs: { id: PrefTab; label: string }[] = [
    { id: 'general', label: 'General' }, { id: 'performance', label: 'Performance' }, { id: 'scratch', label: 'Scratch Disk' },
    { id: 'color', label: 'Color' }, { id: 'guides', label: 'Guides & Grid' }, { id: 'ai', label: 'AI' }, { id: 'updates', label: 'Updates & Privacy' },
  ];
  return (
    <Modal title="Preferences" onClose={close} onOk={ok} width={720} footerLeft={<button className="btn small" onClick={() => setP(structuredClone(DEFAULT_PREFERENCES))}>Restore Defaults</button>}>
      <div className="split-dialog">
        <div className="side-tabs" role="tablist">
          {tabs.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={`side-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
        <div className="tab-body">
          {tab === 'updates' && <UpdatePrivacyPrefs />}
          {tab === 'general' && (
            <div className="grid2">
              <span className="lbl">Auto-save every</span><NumberField value={p.general.autosaveMinutes} min={0} max={60} unit="min (0 = off)" onChange={(v) => upd('general', { autosaveMinutes: Math.round(v) })} width={60} />
              <span className="lbl">UI scale</span><Select value={String(p.general.uiScale)} onChange={(v) => upd('general', { uiScale: Number(v) })} options={['0.9', '1', '1.1', '1.25', '1.5', '2'].map((v) => ({ value: v, label: `${Math.round(Number(v) * 100)}%` }))} />
              <span className="lbl" />
              <Check label="Large UI (accessibility)" checked={p.general.largeUI} onChange={(v) => upd('general', { largeUI: v })} />
              <span className="lbl">Ruler units</span><Select value={p.general.units} onChange={(v) => upd('general', { units: v })} options={[{ value: 'px', label: 'Pixels' }, { value: 'in', label: 'Inches' }, { value: 'cm', label: 'Centimeters' }, { value: 'mm', label: 'Millimeters' }, { value: 'pt', label: 'Points' }, { value: 'percent', label: 'Percent' }]} />
              <span className="lbl">Transparency grid</span><Select value={String(p.general.checkerSize)} onChange={(v) => upd('general', { checkerSize: Number(v) })} options={[{ value: '4', label: 'Small' }, { value: '8', label: 'Medium' }, { value: '16', label: 'Large' }]} />
              <span className="lbl">Recent files</span><NumberField value={p.general.recentLimit} min={0} max={50} onChange={(v) => upd('general', { recentLimit: Math.round(v) })} width={60} />
              <span className="lbl" />
              <Check label="Warn before overwriting a file that changed on disk" checked={p.general.confirmOverwrite} onChange={(v) => upd('general', { confirmOverwrite: v })} />
            </div>
          )}
          {tab === 'performance' && (
            <div className="grid2">
              <span className="lbl">Memory usage</span>
              <div>
                <Slider value={Math.round(p.performance.ramFraction * 100)} min={20} max={90} unit="%" onChange={(v) => upd('performance', { ramFraction: v / 100 })} />
                <div className="faint">{mem ? `Available RAM: ${mb(mem.totalBytes)} · Celenne may use ≈ ${mb(mem.totalBytes * p.performance.ramFraction)}` : 'System memory information unavailable in this environment.'}</div>
              </div>
              <span className="lbl">Display cache</span><NumberField value={p.performance.tileCacheMB} min={128} max={16384} step={64} unit="MB" onChange={(v) => upd('performance', { tileCacheMB: Math.round(v) })} width={80} />
              <span className="lbl">History states</span><NumberField value={p.performance.historyStates} min={5} max={1000} onChange={(v) => upd('performance', { historyStates: Math.round(v) })} width={80} />
              <span className="lbl" />
              <div>
                <Check label="Move old history states to the scratch disk" checked={p.performance.historyToScratch} onChange={(v) => upd('performance', { historyToScratch: v })} />
                {!scratchAvailable() && <div className="faint">Available in the desktop app.</div>}
              </div>
              <span className="lbl">History in memory</span><NumberField value={p.performance.historyMemoryMB} min={128} max={65536} step={128} unit="MB" onChange={(v) => upd('performance', { historyMemoryMB: Math.round(v) })} width={80} />
              <span className="lbl">GPU</span>
              <div>
                <Check label="Use GPU acceleration" checked={p.performance.gpuAcceleration} onChange={(v) => upd('performance', { gpuAcceleration: v })} />
                {p.performance.gpuAcceleration && (
                  <div className="row" style={{ gap: 8, marginTop: 4 }}>
                    <Select value={p.performance.renderer} onChange={(v) => upd('performance', { renderer: v as Preferences['performance']['renderer'] })} options={[{ value: 'auto', label: 'Auto (WebGPU, else WebGL 2)' }, { value: 'webgpu', label: 'WebGPU' }, { value: 'webgl2', label: 'WebGL 2' }, { value: 'canvas2d', label: 'Canvas 2D (CPU)' }]} />
                    <Check label="Composite layers on the GPU (WebGPU)" checked={p.performance.gpuCompositing} onChange={(v) => upd('performance', { gpuCompositing: v })} />
                  </div>
                )}
                <div className="faint">Current renderer: {(window as unknown as { __celenneRenderer?: string }).__celenneRenderer ?? 'not started'} · <a href="#" onClick={(e) => { e.preventDefault(); ui.openDialog('gpuInfo'); }}>GPU details…</a></div>
              </div>
            </div>
          )}
          {tab === 'scratch' && (
            <div className="tab-body">
              <p className="faint" style={{ margin: 0 }}>
                When the history holds more than <b>History in memory</b> (Performance tab), image tiles that only old history steps still use are moved to the scratch disk and read back automatically on undo.
                Recent steps and the open documents always stay in memory. Scratch files are removed when they are no longer needed and when Celenne Studio quits.
              </p>
              {scratchAvailable() ? (
                <div className="grid2">
                  <span className="lbl">Location</span><div className="mono">{scratchLoc || 'Default'}</div>
                  <span className="lbl">Limit</span><NumberField value={p.scratch.maxMB} min={512} max={1048576} step={512} unit="MB" onChange={(v) => upd('scratch', { maxMB: Math.round(v) })} width={90} />
                  <span className="lbl">In use</span><div className="faint">{scratchStats().pagedTiles} tile(s), {mb(Math.max(0, scratchStats().pagedBytes))} · read back {scratchStats().readBacks}×{scratchStats().failures ? ` · ${scratchStats().failures} write failure(s)` : ''}</div>
                </div>
              ) : (
                <div className="faint">The scratch disk is available in the desktop app. In the browser, history stays in memory (bounded by History states).</div>
              )}
            </div>
          )}
          {tab === 'color' && (
            <div className="grid2">
              <span className="lbl">Working RGB</span><Select value={p.color.workingRGB} onChange={(v) => upd('color', { workingRGB: v })} options={BUILTIN_PROFILES.filter((x) => x.space === 'RGB' && x.id !== 'linearSRGB').map((x) => ({ value: x.id as Preferences['color']['workingRGB'], label: x.name }))} />
              <span className="lbl">Display profile</span><Select value={p.color.displayProfile} onChange={(v) => upd('color', { displayProfile: v })} options={[{ value: 'srgb', label: 'sRGB (standard monitors)' }, { value: 'displayP3', label: 'Display P3 (wide-gamut monitors)' }]} />
              <span className="lbl">Rendering intent</span><Select value={p.color.renderingIntent} onChange={(v) => upd('color', { renderingIntent: v })} options={[{ value: 'perceptual', label: 'Perceptual' }, { value: 'relative', label: 'Relative Colorimetric' }, { value: 'saturation', label: 'Saturation' }, { value: 'absolute', label: 'Absolute Colorimetric' }]} />
              <span className="lbl" />
              <Check label="Black point compensation" checked={p.color.blackPointCompensation} onChange={(v) => upd('color', { blackPointCompensation: v })} />
              <span className="lbl">Spot dot gain</span>
              <div>
                <Select value={String(p.color.spotDotGain)} onChange={(v) => upd('color', { spotDotGain: Number(v) })} options={[10, 15, 20, 25, 30].map((g) => ({ value: String(g), label: `Dot Gain ${g}%` }))} />
                <div className="faint">How Duotone and Multichannel inks are shown (50% ink prints as 50% + the gain), like Photoshop’s Color Settings ▸ Spot. Files saved by Photoshop are shown with its own stored rendering until their inks are edited.</div>
              </div>
              <span className="lbl">Proof (CMYK) profile</span>
              <div>
                <div>{proofInfo ? `${proofInfo.description} (${proofInfo.colorSpace})` : <span className="faint">None loaded — View ▸ Proof Colors needs a CMYK ICC profile (e.g. from your print provider).</span>}</div>
                <div className="row">
                  <button className="btn small" onClick={async () => {
                    const f = await pickFile('ICC profiles', ['icc', 'icm']);
                    if (!f) return;
                    const info = parseIccInfo(f.data);
                    if (!info) { ui.toast('error', 'Not a valid ICC profile', f.name); return; }
                    if (f.data.length > 8 * 1024 * 1024) { ui.toast('error', 'Profile is too large'); return; }
                    upd('color', { proofProfile: b64(f.data) });
                  }}>Load Profile…</button>
                  {p.color.proofProfile && <button className="btn small" onClick={() => upd('color', { proofProfile: null })}>Remove</button>}
                </div>
              </div>
              <span className="lbl">Engine</span><span className="faint">LittleCMS (WebAssembly) — {colorEngine.status}{colorEngine.error ? `: ${colorEngine.error}` : ''}</span>
            </div>
          )}
          {tab === 'guides' && (
            <div className="grid2">
              <span className="lbl">Guide color</span><div className="row"><input type="color" value={p.guides.guideColor} onChange={(e) => upd('guides', { guideColor: e.target.value })} aria-label="Guide color" /></div>
              <span className="lbl">Gridline every</span><NumberField value={p.guides.gridSpacing} min={2} max={4096} unit="px" onChange={(v) => upd('guides', { gridSpacing: Math.round(v) })} width={70} />
              <span className="lbl">Subdivisions</span><NumberField value={p.guides.gridSubdivisions} min={1} max={32} onChange={(v) => upd('guides', { gridSubdivisions: Math.round(v) })} width={60} />
              <span className="lbl" />
              <Check label="Smart guides" checked={p.guides.smartGuides} onChange={(v) => upd('guides', { smartGuides: v })} />
            </div>
          )}
          {tab === 'ai' && (
            <div className="grid2">
              <span className="lbl">Provider</span>
              <Select value={p.ai.provider} onChange={(v) => upd('ai', { provider: v })} options={[{ value: 'local', label: 'Local (built-in, offline)' }, { value: 'cloud', label: 'Cloud (your endpoint)' }, { value: 'custom', label: 'Plugin models' }]} />
              <span className="lbl">Cloud endpoint</span>
              <div>
                <input className="txt" style={{ width: '100%' }} placeholder="https://your-ai-service.example/api" value={p.ai.cloudEndpoint} onChange={(e) => upd('ai', { cloudEndpoint: e.target.value.trim() })} />
                <div className="faint">HTTPS only. Images are sent to this endpoint only when you run an AI command with the Cloud provider selected. Protocol: docs/AI_PROVIDERS.md.</div>
                {p.ai.cloudEndpoint && !/^https:\/\//.test(p.ai.cloudEndpoint) && <div className="tag warn">The endpoint must start with https://</div>}
              </div>
              <span className="lbl">Capabilities</span>
              <div className="faint">
                {providers().map((pr) => {
                  const c = pr.capabilities();
                  const on = Object.entries(c).filter(([, v]) => v).map(([k]) => k);
                  return <div key={pr.id}><b>{pr.label}</b>: {on.length ? on.join(', ') : 'not available'}</div>;
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// =============================================================================================
// Keyboard shortcuts
// =============================================================================================
const CATEGORY_LABELS: Record<string, string> = { file: 'File', edit: 'Edit', image: 'Image', layer: 'Layer', type: 'Type', select: 'Select', filter: 'Filter', view: 'View', window: 'Window', help: 'Help', tool: 'Tools' };

export function ShortcutsDialog({ close }: { close: () => void }) {
  const [q, setQ] = useState('');
  const [, force] = useState(0);
  const [recording, setRecording] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; chord: string; conflictId: string } | null>(null);
  useEffect(() => keymap.on(() => force((n) => n + 1)), []);
  const rows = useMemo(() => {
    const a = allActions().filter((x) => x.category !== 'replay').map((x) => ({ id: x.id, label: x.label, cat: x.id.split('.')[0] }));
    const t = TOOLS.map((x) => ({ id: `tool:${x.id}`, label: x.label, cat: 'tool' }));
    return [...t, ...a];
  }, []);
  const labelOf = (id: string) => rows.find((r) => r.id === id)?.label ?? id;
  const filtered = rows.filter((r) => !q || r.label.toLowerCase().includes(q.toLowerCase()) || keymap.bindingsFor(r.id).some((b) => b.toLowerCase().includes(q.toLowerCase())));
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      if (e.key === 'Escape') { setRecording(null); return; }
      const chord = normalizeChord(chordFromEvent(e));
      const other = keymap.conflict(chord, recording);
      if (other) setPending({ id: recording, chord, conflictId: other });
      else keymap.set(recording, [...keymap.bindingsFor(recording).filter((c) => normalizeChord(c) !== chord), chord]);
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);
  const groups = new Map<string, typeof filtered>();
  for (const r of filtered) { const g = groups.get(r.cat) ?? []; g.push(r); groups.set(r.cat, g); }
  return (
    <Modal title="Keyboard Shortcuts" onClose={close} onOk={close} okLabel="Done" width={760} footerLeft={
      <div className="row">
        <button className="btn small" onClick={() => keymap.reset()}>Reset All</button>
        <button className="btn small" onClick={() => saveText('celenne-shortcuts.json', keymap.exportJSON(), 'json')}>Export…</button>
        <button className="btn small" onClick={async () => { const f = await pickFile('Shortcut sets', ['json']); if (!f) return; try { keymap.importJSON(new TextDecoder().decode(f.data)); ui.toast('success', 'Shortcuts imported'); } catch (e) { ui.toast('error', 'Could not import shortcuts', (e as Error).message); } }}>Import…</button>
      </div>
    }>
      <input className="txt" style={{ width: '100%', marginBottom: 8 }} placeholder="Search commands or keys…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search shortcuts" />
      {pending && (
        <div className="tag warn" style={{ display: 'block', marginBottom: 8 }}>
          {pending.chord} is already used by “{labelOf(pending.conflictId)}”.{' '}
          <button className="btn small" onClick={() => { keymap.set(pending.conflictId, keymap.bindingsFor(pending.conflictId).filter((c) => normalizeChord(c) !== pending.chord)); keymap.set(pending.id, [...keymap.bindingsFor(pending.id), pending.chord]); setPending(null); }}>Reassign</button>{' '}
          <button className="btn small" onClick={() => setPending(null)}>Cancel</button>
        </div>
      )}
      <div className="scroll-list" style={{ maxHeight: 460 }}>
        {[...groups].map(([cat, list]) => (
          <div key={cat}>
            <div className="section-title">{CATEGORY_LABELS[cat] ?? cat}</div>
            <table className="kv-table">
              <tbody>
                {list.map((r) => {
                  const b = keymap.bindingsFor(r.id);
                  return (
                    <tr key={r.id}>
                      <td>{r.label.replace('…', '')}</td>
                      <td style={{ width: 260 }}>
                        {b.map((c) => (
                          <span key={c} className="kbd">{c}<button className="icon-x" title="Remove shortcut" aria-label={`Remove ${c}`} onClick={() => keymap.set(r.id, b.filter((x) => x !== c))}>×</button></span>
                        ))}
                        {recording === r.id ? <span className="tag">Press keys… (Esc to cancel)</span> : <button className="btn small" onClick={() => setRecording(r.id)}>+</button>}
                      </td>
                      <td style={{ width: 60 }}><button className="btn small" onClick={() => keymap.reset(r.id)} title="Restore default">Reset</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// =============================================================================================
// About / GPU
// =============================================================================================
export function AboutDialog({ close }: { close: () => void }) {
  const b = platform().bridge;
  return (
    <Modal title="About Celenne Studio" onClose={close} onOk={close} width={520}>
      <h2 style={{ margin: '0 0 4px' }}>Celenne Studio</h2>
      <div className="faint">Version {__APP_VERSION__} · {platform().kind === 'electron' ? `Desktop (${b?.os ?? ''})` : 'Browser build'}{b && <> · <a href="#" onClick={(e) => { e.preventDefault(); close(); ui.openDialog('updates'); }}>Check for Updates…</a></>}</div>
      <p>A layered raster image editor with native PSD/PSB support, non-destructive adjustments, smart objects and color management.</p>
      <div className="section-title">Open-source components</div>
      <ul className="faint" style={{ margin: 0, paddingLeft: 18 }}>
        <li>ag-psd (MIT) — PSD structure parsing and writing</li>
        <li>LittleCMS via lcms-wasm (MIT) — ICC color management</li>
        <li>fflate (MIT) — ZIP compression · UTIF (MIT) — TIFF</li>
        <li>LibRaw 0.22 (LGPL 2.1) — camera raw files. Its source and licence are in the app's licenses/LibRaw folder.</li>
        <li>React, zustand, flexlayout-react (MIT) — user interface</li>
        <li>Electron (MIT) — desktop shell</li>
      </ul>
      {b && <div className="faint mono" style={{ marginTop: 8 }}>{Object.entries(b.versions).filter(([k]) => ['electron', 'chrome', 'node', 'v8'].includes(k)).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>}
      <p className="faint">Photoshop is a trademark of Adobe Inc. Celenne Studio is not affiliated with Adobe.</p>
    </Modal>
  );
}

function gpuDetails() {
  const out: [string, string][] = [];
  out.push(['Active renderer', (window as unknown as { __celenneRenderer?: string }).__celenneRenderer ?? 'not started']);
  out.push(['GPU acceleration preference', editor.prefs.performance.gpuAcceleration ? 'On' : 'Off']);
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      out.push(['WebGL 2', 'Available']);
      out.push(['Vendor', ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR))]);
      out.push(['Renderer', ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))]);
      out.push(['Max texture size', String(gl.getParameter(gl.MAX_TEXTURE_SIZE))]);
      out.push(['Max 3D texture size', String(gl.getParameter(gl.MAX_3D_TEXTURE_SIZE))]);
      out.push(['Float textures (color-buffer)', gl.getExtension('EXT_color_buffer_float') ? 'Yes' : 'No']);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } else out.push(['WebGL 2', 'Unavailable — using the Canvas 2D (CPU) renderer']);
  } catch (e) {
    out.push(['WebGL 2', `Error: ${(e as Error).message}`]);
  }
  const g = currentGpu();
  out.push(['WebGPU', g ? `In use: ${[g.info.vendor, g.info.architecture, g.info.description].filter(Boolean).join(' · ') || 'adapter'}` : webgpuAvailable() ? `Available, not in use${gpuError ? ` (${gpuError})` : ''}` : 'Not available']);
  if (g) {
    const st = g.compositor.stats;
    out.push(['GPU compositing', editor.prefs.performance.gpuCompositing ? `On · ${st.gpuTiles} tiles on the GPU, ${st.cpuTiles} on the CPU${st.lastFallback ? ` (last CPU reason: ${st.lastFallback})` : ''}` : 'Off (preference)']);
  }
  out.push(['CPU threads', String(navigator.hardwareConcurrency ?? '?')]);
  out.push(['Color engine', `${colorEngine.status}${colorEngine.error ? ` (${colorEngine.error})` : ''}`]);
  out.push(['Device pixel ratio', String(window.devicePixelRatio)]);
  return out;
}

export function GpuInfoDialog({ close }: { close: () => void }) {
  const rows = useMemo(gpuDetails, []);
  return (
    <Modal title="GPU Information" onClose={close} onOk={close} width={560}>
      <table className="kv-table"><tbody>{rows.map(([k, v]) => <tr key={k}><td className="faint">{k}</td><td className="mono">{v}</td></tr>)}</tbody></table>
    </Modal>
  );
}

// =============================================================================================
// File Info / Document Properties
// =============================================================================================
export function FileInfoDialog({ close }: { close: () => void }) {
  const s = editor.active;
  const [m, setM] = useState<DocumentMetadata>(() => ({ ...(s?.doc.metadata ?? {}) }));
  if (!s) { close(); return null; }
  const ok = () => {
    const before = { ...s.doc.metadata };
    const after = { ...m, modified: new Date().toISOString() };
    s.push(new LambdaCommand('File Info', (d) => { d.metadata = { ...after }; }, (d) => { d.metadata = { ...before }; }));
    close();
  };
  const f = (k: keyof DocumentMetadata, label: string, multi = false) => (
    <>
      <span className="lbl">{label}</span>
      {multi
        ? <textarea className="txt" rows={3} value={(m[k] as string) ?? ''} onChange={(e) => setM({ ...m, [k]: e.target.value })} />
        : <input className="txt" value={(m[k] as string) ?? ''} onChange={(e) => setM({ ...m, [k]: e.target.value })} />}
    </>
  );
  return (
    <Modal title={`File Info — ${s.doc.name}`} onClose={close} onOk={ok} width={560}>
      <div className="grid2">
        {f('title', 'Document title')}
        {f('author', 'Author')}
        {f('description', 'Description', true)}
        <span className="lbl">Keywords</span><input className="txt" value={(m.keywords ?? []).join(', ')} onChange={(e) => setM({ ...m, keywords: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="comma, separated" />
        <span className="lbl">Copyright status</span><Select value={m.copyrighted === undefined ? 'unknown' : m.copyrighted ? 'yes' : 'no'} onChange={(v) => setM({ ...m, copyrighted: v === 'unknown' ? undefined : v === 'yes' })} options={[{ value: 'unknown', label: 'Unknown' }, { value: 'yes', label: 'Copyrighted' }, { value: 'no', label: 'Public Domain' }]} />
        {f('copyright', 'Copyright notice')}
        {f('url', 'Copyright info URL')}
        <span className="lbl">XMP</span><span className="faint">{m.xmp ? `${m.xmp.length.toLocaleString()} characters preserved` : 'None'}</span>
      </div>
    </Modal>
  );
}

export function DocInfoDialog({ close }: { close: () => void }) {
  const s = editor.active;
  const info = useMemo(() => {
    if (!s) return [];
    const d = s.doc;
    let layers = 0, rasterBytes = 0;
    const kinds = new Map<string, number>();
    for (const l of d.walk()) {
      layers++;
      kinds.set(l.kind, (kinds.get(l.kind) ?? 0) + 1);
      if (hasRaster(l)) rasterBytes += l.raster.byteSize();
      if (l.mask) rasterBytes += l.mask.raster.byteSize();
    }
    const c = d.canvas;
    return [
      ['Name', d.name],
      ['File', d.filePath ?? 'Not saved'],
      ['Format', d.fileFormat ?? '—'],
      ['Dimensions', `${c.width} × ${c.height} px (${((c.width * c.height) / 1e6).toFixed(1)} MP)`],
      ['Print size', `${(c.width / c.resolution).toFixed(2)} × ${(c.height / c.resolution).toFixed(2)} in at ${c.resolution} ppi`],
      ['Color mode', `${c.colorMode === 'rgb' ? 'RGB' : 'Grayscale'} · ${c.bitDepth} bits/channel${c.bitDepth === 32 ? ' (float, linear)' : ''}`],
      ['Color profile', d.profile.name + (d.profile.icc ? ' (embedded)' : '')],
      ['Layers', `${layers} — ${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}`],
      ['Channels / paths', `${d.channels.length} alpha · ${d.paths.length} paths · ${d.guides.length} guides`],
      ['Smart object sources', String(d.smartSources.size)],
      ['Layer pixel memory', mb(rasterBytes)],
      ['History', `${s.history.entries.length} states · ${mb(s.history.memoryBytes())}`],
      ['Display cache', mb(s.engine.cacheBytes())],
      ['Compatibility notes', String(d.compatibility.length)],
      ['Created', d.metadata.created ?? '—'],
      ['Modified', d.metadata.modified ?? '—'],
    ];
  }, [s]);
  if (!s) { close(); return null; }
  return (
    <Modal title="Document Properties" onClose={close} onOk={close} width={600} footerLeft={<button className="btn small" onClick={() => ui.openDialog('fileInfo')}>File Info…</button>}>
      <table className="kv-table"><tbody>{info.map(([k, v]) => <tr key={k}><td className="faint" style={{ width: 170 }}>{k}</td><td>{v}</td></tr>)}</tbody></table>
    </Modal>
  );
}

// =============================================================================================
// Missing fonts
// =============================================================================================
export function MissingFontsDialog({ close, sessionId, fonts: missing }: { close: () => void; sessionId: string; fonts: string[] }) {
  const s = editor.session(sessionId);
  const [subs, setSubs] = useState<Record<string, string>>(() => Object.fromEntries(missing.map((f) => [f, fonts.substitute(fonts.byPostScript(f)?.family ?? f.replace(/-.*$/, ''), 400)])));
  if (!s) { close(); return null; }
  const replace = () => {
    recordStateChange(s.doc, s.history, 'Replace Fonts', () => {
      for (const l of s.doc.walk()) {
        if (l.kind !== 'text' || !l.missingFonts.length) continue;
        const t = l as TextLayer;
        let changed = false;
        for (const run of t.text.runs) {
          const key = run.style.postScriptName ?? run.style.fontFamily;
          const sub = subs[key] ?? subs[run.style.fontFamily];
          if (!sub) continue;
          // The original font is kept in metadata so the substitution is traceable.
          const orig = (t.metadata.custom ??= {});
          const list = (orig.originalFonts as string[] | undefined) ?? [];
          if (!list.includes(key)) orig.originalFonts = [...list, key];
          run.style = { ...run.style, fontFamily: sub, postScriptName: undefined };
          changed = true;
        }
        if (changed) updateAppearance(s.doc, t);
      }
    });
    s.engine.invalidateAll();
    close();
  };
  return (
    <Modal title="Missing Fonts" onClose={close} onOk={replace} okLabel="Replace Fonts" width={600} footerLeft={<button className="btn" onClick={close}>Keep Original Fonts</button>}>
      <p>This document uses fonts that are not installed. Text layers keep their stored appearance and original font names until you edit them or replace the fonts.</p>
      <table className="kv-table">
        <tbody>
          {missing.map((f) => (
            <tr key={f}>
              <td><span style={{ color: 'var(--warning)' }}>Font not installed: {f}</span></td>
              <td style={{ width: 240 }}>
                <Select value={subs[f]} onChange={(v) => setSubs({ ...subs, [f]: v })} options={[...new Set([subs[f], ...fonts.families])].filter(Boolean).map((x) => ({ value: x, label: x }))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!fonts.families.length && <div className="faint">The system font list is unavailable (local font access was not granted); common substitutes are offered.</div>}
    </Modal>
  );
}

// =============================================================================================
// Recovered documents
// =============================================================================================
export function RecoveredDialog({ close }: { close: () => void }) {
  const [list, setList] = useState<RecoveryEntry[] | null>(null);
  const reload = () => platform().recovery.list().then((l) => setList(l.filter((e) => !editor.sessions.some((s) => s.id === e.id)).sort((a, b) => b.savedAt - a.savedAt))).catch(() => setList([]));
  useEffect(() => { reload(); }, []);
  const open = async (e: RecoveryEntry) => {
    const data = await platform().recovery.load(e.id);
    if (!data) { ui.toast('error', 'The recovery file could not be read.'); return; }
    const s = await openBytes(`${e.name}.psd`, null, data);
    if (s) {
      s.doc.name = `${e.name} (Recovered)`;
      // Recovered documents are unsaved: the user decides where to save them.
      s.doc.filePath = null;
      s.markUnsaved();
      editor.syncSessions();
      await platform().recovery.remove(e.id);
    }
    reload();
  };
  const discard = async (e: RecoveryEntry) => {
    if ((await platform().confirm(`Discard the recovered copy of "${e.name}"?`, 'This cannot be undone.', ['Discard', 'Cancel'])) !== 0) return;
    await platform().recovery.remove(e.id);
    reload();
  };
  return (
    <Modal title="Recovered Documents" onClose={close} onOk={close} okLabel="Close" width={620}>
      {list === null ? <div className="faint">Loading…</div> : list.length === 0 ? <div className="faint">No recovered documents. Celenne Studio auto-saves open documents every {editor.prefs.general.autosaveMinutes} minutes (Preferences › General).</div> : (
        <table className="kv-table">
          <tbody>
            {list.map((e) => (
              <tr key={e.id}>
                <td><b>{e.name}</b><div className="faint">{e.originalPath ?? 'Never saved'} · {new Date(e.savedAt).toLocaleString()} · {mb(e.byteSize)}</div></td>
                <td style={{ width: 150, textAlign: 'right' }}><button className="btn small primary" onClick={() => open(e)}>Open</button> <button className="btn small" onClick={() => discard(e)}>Discard</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

// =============================================================================================
// Assign / Convert profile
// =============================================================================================
export function ProfileDialog({ close, mode }: { close: () => void; mode: 'assign' | 'convert' }) {
  const s = editor.active;
  const gray = s?.doc.canvas.colorMode === 'grayscale';
  const cmyk = s?.doc.canvas.colorMode === 'cmyk';
  const lab = s?.doc.canvas.colorMode === 'lab';
  const space = cmyk ? 'CMYK' : gray ? 'GRAY' : 'RGB';
  // Convert to Profile can also target a CMYK profile from RGB / Gray (this converts the mode).
  const choices = BUILTIN_PROFILES.filter((p) => p.space === space || (mode === 'convert' && !cmyk && p.space === 'CMYK'));
  const working = workingCmykProfile();
  const [sel, setSel] = useState<string>(choices[0].id);
  const [custom, setCustom] = useState<ColorProfileRef | null>(() => (working.icc && (cmyk || mode === 'convert') ? working : null));
  const [intent, setIntent] = useState<Intent>(editor.prefs.color.renderingIntent);
  const [bpc, setBpc] = useState(editor.prefs.color.blackPointCompensation);
  if (!s) { close(); return null; }
  if (lab) { close(); ui.toast('info', 'Lab documents are device-independent and have no profile to assign or convert.', 'Use Image ▸ Mode to convert to RGB or CMYK.'); return null; }
  const target = (): ColorProfileRef | BuiltinProfileId => (sel === 'custom' && custom ? custom : (sel as BuiltinProfileId));
  const ok = async () => {
    close();
    const t = target();
    if (mode === 'assign') assignProfile(typeof t === 'string' ? { name: BUILTIN_PROFILES.find((p) => p.id === t)!.name, builtin: t } : t);
    else await convertToProfile(t, intent, bpc);
  };
  return (
    <Modal title={mode === 'assign' ? 'Assign Profile' : 'Convert to Profile'} onClose={close} onOk={ok} width={520}>
      <div className="grid2">
        <span className="lbl">Current</span><span>{s.doc.profile.name}</span>
        <span className="lbl">{mode === 'assign' ? 'Assign' : 'Destination'}</span>
        <div className="row">
          <Select value={sel} onChange={setSel} options={[...choices.map((p) => ({ value: p.id as string, label: p.name })), ...(custom ? [{ value: 'custom', label: custom.name }] : [])]} />
          <button className="btn small" onClick={async () => {
            const f = await pickFile('ICC profiles', ['icc', 'icm']);
            if (!f) return;
            const info = parseIccInfo(f.data);
            if (!info) { ui.toast('error', 'Not a valid ICC profile', f.name); return; }
            const okSpace = info.colorSpace.trim() === space || (mode === 'convert' && !cmyk && info.colorSpace === 'CMYK');
            if (!okSpace) { ui.toast('warning', `This document needs a${gray ? ' Gray' : cmyk ? ' CMYK' : 'n RGB'} profile; ${info.colorSpace} profiles are not supported here.`); return; }
            setCustom({ name: info.description, icc: f.data });
            setSel('custom');
          }}>Load…</button>
        </div>
        {mode === 'convert' && (
          <>
            <span className="lbl">Intent</span><Select value={intent} onChange={setIntent} options={[{ value: 'perceptual', label: 'Perceptual' }, { value: 'relative', label: 'Relative Colorimetric' }, { value: 'saturation', label: 'Saturation' }, { value: 'absolute', label: 'Absolute Colorimetric' }]} />
            <span className="lbl" /><Check label="Use black point compensation" checked={bpc} onChange={setBpc} />
          </>
        )}
      </div>
      <p className="faint">{mode === 'assign' ? 'Assigning changes how the pixel values are interpreted (their appearance changes, the numbers do not).' : 'Converting changes the pixel values so the appearance is preserved in the new profile.'} Tonal adjustment layers keep their settings.</p>
    </Modal>
  );
}

// =============================================================================================
// Export As
// =============================================================================================
export function ExportAsDialog({ close, format }: { close: () => void; format?: string }) {
  const s = editor.active;
  const list = exporters.filter((e) => !e.layered);
  const [fmt, setFmtState] = useState(format && list.some((e) => e.id === format && e.available) ? format : list.find((e) => e.available)?.id ?? 'png');
  const [quality, setQuality] = useState(fmt === 'pdf' ? 100 : 90);
  // PDF defaults to lossless; JPEG/WebP to 90 %.
  const setFmt = (f: string) => { setFmtState(f); setQuality(f === 'pdf' ? 100 : 90); };
  const [embed, setEmbed] = useState(true);
  const [matte, setMatte] = useState({ r: 1, g: 1, b: 1 });
  const [force8, setForce8] = useState(false);
  if (!s) { close(); return null; }
  const e = list.find((x) => x.id === fmt)!;
  const lossy = fmt === 'jpeg' || fmt === 'webp' || fmt === 'pdf';
  const ok = async () => {
    close();
    await exportAs(s, fmt, { quality: quality / 100, embedProfile: embed, matte: [matte.r * 255, matte.g * 255, matte.b * 255], force8 });
  };
  return (
    <Modal title="Export As" onClose={close} onOk={ok} okLabel="Export…" okDisabled={!e.available} width={500}>
      <div className="grid2">
        <span className="lbl">Format</span>
        <Select value={fmt} onChange={setFmt} options={list.map((x) => ({ value: x.id, label: x.available ? x.label : `${x.label} — Coming Soon`, disabled: !x.available }))} />
        {lossy && (<><span className="lbl">Quality</span><Slider value={quality} min={1} max={100} onChange={setQuality} /></>)}
        {fmt === 'jpeg' && (<><span className="lbl">Matte</span><ColorSwatch color={matte} onClick={() => ui.openDialog('colorPicker', { purpose: 'callback', initial: matte, onPick: setMatte })} /></>)}
        <span className="lbl" /><Check label="Embed color profile" checked={embed} onChange={setEmbed} />
        {e.supports16 && s.doc.canvas.bitDepth > 8 && (<><span className="lbl" /><Check label="Convert to 8 bits/channel" checked={force8} onChange={setForce8} /></>)}
      </div>
      <div className="faint">
        {e.note ?? ''} {exportModeNote(e, s.doc)} Export writes a flattened copy; your document and its layers are not changed.
        {s.doc.canvas.bitDepth > 8 && !e.supports16 && ` ${e.label} is 8-bit only, so the exported copy is converted from ${s.doc.canvas.bitDepth}-bit.`}
      </div>
    </Modal>
  );
}

// =============================================================================================
// Compatibility
// =============================================================================================
const LEVEL_LABEL: Record<Level, string> = { yes: '✓', partial: 'Partial', no: '—', preserve: 'Preserved', render: 'Rendered' };

export function CompatMatrixDialog({ close }: { close: () => void }) {
  return (
    <Modal title="PSD Compatibility Matrix" onClose={close} onOk={close} okLabel="Close" width={900}>
      <div className="scroll-list" style={{ maxHeight: 520 }}>
        <table className="kv-table compat">
          <thead><tr><th>Feature</th><th>Read</th><th>Edit</th><th>Write</th><th>Preserve</th><th>Notes</th></tr></thead>
          <tbody>
            {COMPATIBILITY.map((r) => (
              <tr key={r.feature}>
                <td>{r.feature}</td>
                {(['read', 'edit', 'write', 'preserve'] as const).map((k) => <td key={k} className={`lvl-${r[k]}`}>{LEVEL_LABEL[r[k]]}</td>)}
                <td className="faint">{r.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

export function CompatibilityDialog({ close }: { close: () => void }) {
  const s = editor.active;
  if (!s) { close(); return null; }
  const issues = s.doc.compatibility;
  const order = ['dropped', 'converted', 'rendered', 'preserved', 'partial', 'editable'];
  const sorted = [...issues].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <Modal title={`Compatibility Report — ${s.doc.name}`} onClose={close} onOk={close} okLabel="Close" width={760} footerLeft={<button className="btn small" onClick={() => ui.openDialog('compatMatrix')}>Full Matrix…</button>}>
      {issues.length === 0 ? <p>Every feature in this document is fully editable in Celenne Studio.</p> : (
        <>
          <p>Some Photoshop features in this document are not currently editable. They have been preserved where possible.</p>
          <div className="scroll-list" style={{ maxHeight: 440 }}>
            <table className="kv-table">
              <thead><tr><th>Status</th><th>Feature</th><th>Layer</th><th>Details</th></tr></thead>
              <tbody>
                {sorted.map((i, n) => (
                  <tr key={n}>
                    <td><span className={`tag status-${i.status}`}>{i.status}</span></td>
                    <td>{i.feature}</td>
                    <td>{i.layerName ? <a href="#" onClick={(e) => { e.preventDefault(); if (i.layerId) { s.setActive(i.layerId); ui.bump('docRev'); } }}>{i.layerName}</a> : '—'}</td>
                    <td className="faint">{i.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

// =============================================================================================
// Plugins
// =============================================================================================
export function PluginsDialog({ close }: { close: () => void }) {
  const [, force] = useState(0);
  const [panel, setPanel] = useState<{ title: string; html: string } | null>(null);
  useEffect(() => plugins.on(() => force((n) => n + 1)), []);
  const install = async (p: PluginPackage) => {
    const m = p.manifest;
    const what = [
      m.contributes.filters?.length ? `${m.contributes.filters.length} filter(s)` : '',
      m.contributes.exporters?.length ? `${m.contributes.exporters.length} exporter(s)` : '',
      m.contributes.panels?.length ? `${m.contributes.panels.length} panel(s)` : '',
      m.contributes.importers?.length ? `${m.contributes.importers.length} importer(s)` : '',
      m.contributes.tools?.length ? `${m.contributes.tools.length} tool(s)` : '',
      m.contributes.scripts?.length ? `${m.contributes.scripts.length} script(s)` : '',
      m.contributes.aiTasks?.length ? `AI tasks: ${m.contributes.aiTasks.join(', ')}` : '',
    ].filter(Boolean).join(', ');
    const r = await platform().confirm(`Install "${m.name}" ${m.version}${m.author ? ` by ${m.author}` : ''}?`, `Adds ${what || 'nothing'}. Plugins run in an isolated sandbox without network, file or document access; they only receive the pixels you apply them to or the files you open with them. Scripts can only propose app commands, which you confirm before they run.`, ['Install', 'Cancel']);
    if (r !== 0) return;
    try { plugins.install(p); ui.toast('success', `Installed ${m.name}`); } catch (e) { ui.toast('error', 'Plugin rejected', (e as Error).message); }
  };
  return (
    <Modal title="Plugins" onClose={close} onOk={close} okLabel="Close" width={680} footerLeft={
      <div className="row">
        <button className="btn small" onClick={async () => {
          const f = await pickFile('Celenne plugins', ['json', 'lplugin']);
          if (!f) return;
          if (f.data.length > 4 * 1024 * 1024) { ui.toast('error', 'Plugin file is too large'); return; }
          try { await install(JSON.parse(new TextDecoder().decode(f.data)) as PluginPackage); } catch (e) { ui.toast('error', 'Not a valid plugin package', (e as Error).message); }
        }}>Install from File…</button>
        <button className="btn small" onClick={() => install(SAMPLE_PLUGIN)}>Install Sample Plugin</button>
      </div>
    }>
      {plugins.list().length === 0 ? <p className="faint">No plugins installed. Plugin packages are JSON files with a manifest and sandboxed code (see docs/PLUGINS.md).</p> : (
        <table className="kv-table">
          <tbody>
            {plugins.list().map(({ pkg: p, enabled }) => (
              <tr key={p.manifest.id}>
                <td>
                  <b>{p.manifest.name}</b> <span className="faint">{p.manifest.version} · {p.manifest.id}</span>
                  <div className="faint">{p.manifest.description}</div>
                  <div className="faint">
                    {[
                      ...(p.manifest.contributes.filters ?? []).map((f) => `Filter: ${f.name}`),
                      ...(p.manifest.contributes.exporters ?? []).map((e) => `Export: ${e.label}`),
                      ...(p.manifest.contributes.importers ?? []).map((e) => `Open: ${e.label} (.${e.extensions.join(', .')})`),
                      ...(p.manifest.contributes.tools ?? []).map((t) => `Tool: ${t.name}`),
                      ...(p.manifest.contributes.scripts ?? []).map((t) => `Script: ${t.name}`),
                    ].join(' · ')}
                  </div>
                  {(p.manifest.contributes.panels ?? []).map((pn) => <button key={pn.id} className="btn small" disabled={!enabled} onClick={() => setPanel(pn)}>Open panel: {pn.title}</button>)}
                </td>
                <td style={{ width: 170, textAlign: 'right' }}>
                  <Check label="Enabled" checked={enabled} onChange={(v) => plugins.setEnabled(p.manifest.id, v)} />
                  <button className="btn small" onClick={async () => { if ((await platform().confirm(`Remove "${p.manifest.name}"?`, undefined, ['Remove', 'Cancel'])) === 0) plugins.remove(p.manifest.id); }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="faint" style={{ marginTop: 8 }}>Plugin tools appear as the Plugin Tool in the toolbar, scripts under File ▸ Scripts, importers in File ▸ Open.</div>
      {panel && (
        <div style={{ marginTop: 8 }}>
          <div className="section-title">{panel.title} <button className="btn small" onClick={() => setPanel(null)}>Close panel</button></div>
          {/* No allow-same-origin: the panel cannot reach the app, its storage or its origin. */}
          <iframe title={panel.title} sandbox="allow-scripts" srcDoc={panel.html} style={{ width: '100%', height: 200, border: '1px solid var(--border)', background: '#222' }} />
        </div>
      )}
    </Modal>
  );
}

// =============================================================================================
// Command palette
// =============================================================================================
function score(label: string, q: string): number {
  const l = label.toLowerCase();
  if (!q) return 1;
  const i = l.indexOf(q);
  if (i === 0) return 100;
  if (i > 0) return 60 - i;
  // Subsequence match.
  let p = 0, s = 0;
  for (const ch of q) {
    const j = l.indexOf(ch, p);
    if (j < 0) return 0;
    s += j === p ? 3 : 1;
    p = j + 1;
  }
  return s;
}

export function CommandPaletteDialog({ close }: { close: () => void }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return allActions()
      .filter((a) => !a.comingSoon && a.category !== 'replay')
      .map((a) => ({ a, s: score(`${CATEGORY_LABELS[a.id.split('.')[0]] ?? ''} ${a.label}`, qq) + score(a.label, qq) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, 60)
      .map((x) => x.a);
  }, [q]);
  const exec = (i: number) => {
    const a = items[i];
    if (!a) return;
    if (a.enabled && !a.enabled()) { ui.toast('info', `${a.label.replace('…', '')} is not available right now.`); return; }
    close();
    setTimeout(() => run(a.id), 0);
  };
  useEffect(() => { listRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' }); }, [idx]);
  return (
    <Modal title="Command Palette" onClose={close} width={560} noFooter>
      <input
        className="txt"
        style={{ width: '100%' }}
        autoFocus
        placeholder="Type a command…"
        value={q}
        aria-label="Command"
        onChange={(e) => { setQ(e.target.value); setIdx(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); exec(idx); }
        }}
      />
      <div className="scroll-list palette" ref={listRef} role="listbox" style={{ maxHeight: 380, marginTop: 6 }}>
        {items.map((a, i) => {
          const disabled = a.enabled ? !a.enabled() : false;
          return (
            <div key={a.id} role="option" aria-selected={i === idx} className={`palette-item ${i === idx ? 'active' : ''} ${disabled ? 'disabled' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => exec(i)}>
              <span className="faint" style={{ width: 70, display: 'inline-block' }}>{CATEGORY_LABELS[a.id.split('.')[0]] ?? ''}</span>
              <span>{a.label.replace('…', '')}</span>
              <span className="kbd-hint">{keymap.bindingsFor(a.id)[0] ?? ''}</span>
            </div>
          );
        })}
        {items.length === 0 && <div className="faint">No matching commands.</div>}
      </div>
    </Modal>
  );
}


