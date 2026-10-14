/**
 * Renders the dialog stack from the store. Dialogs are requested by type string
 * (`ui.openDialog('imageSize')`) so application code never imports UI components.
 * Also hosts the in-app confirmation modal used by platform().confirm().
 */
import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { useApp, ui } from '../../app/store';
import { Modal } from './Modal';
import * as Doc from './DocumentDialogs';
import * as Edit from './EditingDialogs';
import * as Misc from './MiscDialogs';
import { LayerStyleDialog } from './LayerStyleDialog';
import * as Feat from './FeatureDialogs';
import * as ModeD from './ModeDialogs';
import * as Upd from './UpdateDialogs';

// Liquify is large and rarely opened: loaded on demand.
const LiquifyDialog = lazy(() => import('./LiquifyDialog').then((m) => ({ default: m.LiquifyDialog })));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDialog = ComponentType<any>;

const DIALOGS: Record<string, AnyDialog> = {
  newDocument: Doc.NewDocumentDialog,
  imageSize: Doc.ImageSizeDialog,
  canvasSize: Doc.CanvasSizeDialog,
  generativeExpand: Doc.GenerativeExpandDialog,
  sliceOptions: Doc.SliceOptionsDialog,
  indexedColor: ModeD.IndexedColorDialog,
  bitmapMode: ModeD.BitmapModeDialog,
  colorTable: ModeD.ColorTableDialog,
  duotone: ModeD.DuotoneDialog,
  channelOptions: ModeD.ChannelOptionsDialog,
  rotateCanvas: Doc.RotateCanvasDialog,
  trim: Doc.TrimDialog,
  fill: Doc.FillDialog,
  stroke: Doc.StrokeDialog,
  modifySelection: Doc.ModifySelectionDialog,
  newGuide: Doc.NewGuideDialog,
  newGuideLayout: Doc.NewGuideLayoutDialog,
  customZoom: Doc.CustomZoomDialog,
  loadSelection: Doc.LoadSelectionDialog,
  prompt: Doc.PromptDialog,
  saveCompat: Doc.SaveCompatDialog,
  colorPicker: Edit.ColorPickerDialog,
  filter: Edit.FilterDialog,
  adjustment: Edit.AdjustmentDialog,
  colorRange: Edit.ColorRangeDialog,
  selectAndMask: Edit.SelectAndMaskDialog,
  layerStyle: LayerStyleDialog,
  preferences: Misc.PreferencesDialog,
  shortcuts: Misc.ShortcutsDialog,
  about: Misc.AboutDialog,
  updates: Upd.UpdatesDialog,
  reports: Upd.ErrorReportsDialog,
  reportPrompt: Upd.ReportPromptDialog,
  fileInfo: Misc.FileInfoDialog,
  docInfo: Misc.DocInfoDialog,
  missingFonts: Misc.MissingFontsDialog,
  recovered: Misc.RecoveredDialog,
  profile: Misc.ProfileDialog,
  exportAs: Misc.ExportAsDialog,
  compatMatrix: Misc.CompatMatrixDialog,
  compatibility: Misc.CompatibilityDialog,
  gpuInfo: Misc.GpuInfoDialog,
  plugins: Misc.PluginsDialog,
  commandPalette: Misc.CommandPaletteDialog,
  liquify: LiquifyDialog,
  warpText: Feat.WarpTextDialog,
  filterGallery: Feat.FilterGalleryDialog,
  focusArea: Feat.FocusAreaDialog,
  matchFont: Feat.MatchFontDialog,
};

export function DialogHost() {
  const dialogs = useApp((s) => s.dialogs);
  return (
    <>
      {dialogs.map((d) => {
        const C = DIALOGS[d.type];
        const close = () => ui.closeDialog(d.id);
        if (!C) {
          return (
            <Modal key={d.id} title="Coming Soon" onClose={close} onOk={close}>
              This dialog ({d.type}) is coming soon.
            </Modal>
          );
        }
        return (
          <Suspense key={d.id} fallback={null}>
            <C {...(d.props ?? {})} close={close} />
          </Suspense>
        );
      })}
      <ConfirmHost />
    </>
  );
}

interface ConfirmRequest {
  message: string;
  detail?: string;
  buttons: string[];
  resolve: (i: number) => void;
}

/** In-app replacement for window.confirm (browser build; Electron uses native message boxes). */
function ConfirmHost() {
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  useEffect(() => {
    const w = window as unknown as { __celenneConfirm?: (m: string, d: string | undefined, b: string[]) => Promise<number> };
    w.__celenneConfirm = (message, detail, buttons) => new Promise<number>((resolve) => setQueue((q) => [...q, { message, detail, buttons, resolve }]));
    return () => { delete w.__celenneConfirm; };
  }, []);
  const cur = queue[0];
  if (!cur) return null;
  const answer = (i: number) => {
    cur.resolve(i);
    setQueue((q) => q.slice(1));
  };
  const cancelIndex = cur.buttons.length - 1;
  return (
    <Modal title="Celenne Studio" onClose={() => answer(cancelIndex)} noFooter width={440}>
      <p style={{ marginTop: 0 }}><b>{cur.message}</b></p>
      {cur.detail && <p className="faint">{cur.detail}</p>}
      <div className="modal-foot" style={{ padding: 0, border: 0 }}>
        <div className="left" />
        {cur.buttons.map((b, i) => (
          <button key={b} className={`btn ${i === 0 ? 'primary' : ''}`} autoFocus={i === 0} onClick={() => answer(i)}>{b}</button>
        ))}
      </div>
    </Modal>
  );
}
