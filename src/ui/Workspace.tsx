/** Dockable workspace: canvas area plus panel tabsets (flexlayout), persisted per user. */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Actions, DockLocation, IJsonModel, Layout, Model, TabNode, TabSetNode } from 'flexlayout-react';
import 'flexlayout-react/style/dark.css';
import { CanvasView } from './CanvasView';
import { PANELS } from './panels/registry';

const KEY = 'celenne.workspace.v2';

const tab = (id: string) => ({ type: 'tab' as const, id, name: PANELS.find((p) => p.id === id)!.title, component: id });

export const DEFAULT_LAYOUT: IJsonModel = {
  global: {
    tabEnableRename: false,
    tabSetMinWidth: 200,
    tabSetMinHeight: 60,
    tabSetEnableMaximize: false,
    tabEnablePopout: false,
  },
  borders: [],
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        id: 'center',
        weight: 78,
        enableTabStrip: false,
        enableDrop: false,
        enableDrag: false,
        enableDivide: false,
        children: [{ type: 'tab', id: 'canvas', name: 'Canvas', component: 'canvas', enableClose: false, enableDrag: false }],
      },
      {
        type: 'row',
        weight: 22,
        children: [
          { type: 'tabset', id: 'ts-color', weight: 24, children: [tab('color'), tab('swatches'), tab('gradients'), tab('navigator')] },
          { type: 'tabset', id: 'ts-props', weight: 32, children: [tab('properties'), tab('adjustments'), tab('info'), tab('character'), tab('paragraph'), tab('brushSettings')] },
          { type: 'tabset', id: 'ts-layers', weight: 44, children: [tab('layers'), tab('channels'), tab('paths'), tab('history'), tab('actions')] },
        ],
      },
    ],
  },
};

const lazies = new Map<string, ComponentType>();
function panelComponent(id: string): ComponentType {
  let c = lazies.get(id);
  if (!c) {
    const def = PANELS.find((p) => p.id === id);
    c = lazy(async () => ({ default: def ? await def.load() : () => <div className="empty">Unknown panel</div> }));
    lazies.set(id, c);
  }
  return c;
}

function loadModel(): Model {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return Model.fromJson(JSON.parse(raw));
  } catch {
    /* fall back to default */
  }
  return Model.fromJson(DEFAULT_LAYOUT);
}

export function Workspace() {
  const [model, setModel] = useState<Model>(() => loadModel());
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    const isOpen = (id: string) => !!modelRef.current.getNodeById(id);
    (window as unknown as { __celennePanelOpen?: (id: string) => boolean }).__celennePanelOpen = isOpen;
    const toggle = (e: Event, showOnly = false) => {
      const id = (e as CustomEvent<string>).detail;
      const m = modelRef.current;
      const node = m.getNodeById(id);
      if (node) {
        const parent = node.getParent();
        const selected = parent instanceof TabSetNode && parent.getSelectedNode() === node;
        if (selected && showOnly) return;
        if (selected) m.doAction(Actions.deleteTab(id));
        else m.doAction(Actions.selectTab(id));
      } else {
        let target: TabSetNode | undefined;
        m.visitNodes((n) => {
          if (!target && n instanceof TabSetNode && n.getId() !== 'center') target = n;
        });
        if (target) m.doAction(Actions.addNode(tab(id), target.getId(), DockLocation.CENTER, -1, true));
        else m.doAction(Actions.addNode(tab(id), 'center', DockLocation.RIGHT, -1, true));
      }
      localStorage.setItem(KEY, JSON.stringify(m.toJson()));
    };
    const reset = () => {
      localStorage.removeItem(KEY);
      setModel(Model.fromJson(DEFAULT_LAYOUT));
    };
    const show = (e: Event) => toggle(e, true);
    window.addEventListener('celenne:togglePanel', toggle);
    window.addEventListener('celenne:showPanel', show);
    window.addEventListener('celenne:resetWorkspace', reset);
    return () => {
      window.removeEventListener('celenne:togglePanel', toggle);
      window.removeEventListener('celenne:showPanel', show);
      window.removeEventListener('celenne:resetWorkspace', reset);
    };
  }, []);

  const factory = useMemo(
    () => (node: TabNode) => {
      const comp = node.getComponent();
      if (comp === 'canvas') return <CanvasView />;
      const C = panelComponent(comp ?? '');
      return (
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <C />
        </Suspense>
      );
    },
    [],
  );

  return (
    <div className="workspace">
      <Layout model={model} factory={factory} onModelChange={(m) => localStorage.setItem(KEY, JSON.stringify(m.toJson()))} />
    </div>
  );
}
