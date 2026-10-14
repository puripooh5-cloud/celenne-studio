/** Panel registry: ids, titles and components (used by the workspace and the Window menu). */
import type { ComponentType } from 'react';

export interface PanelDef {
  id: string;
  title: string;
  load: () => Promise<ComponentType>;
}

export const PANELS: PanelDef[] = [
  { id: 'layers', title: 'Layers', load: async () => (await import('./LayersPanel')).LayersPanel },
  { id: 'properties', title: 'Properties', load: async () => (await import('./PropertiesPanel')).PropertiesPanel },
  { id: 'adjustments', title: 'Adjustments', load: async () => (await import('./MiscPanels')).AdjustmentsPanel },
  { id: 'history', title: 'History', load: async () => (await import('./DocPanels')).HistoryPanel },
  { id: 'channels', title: 'Channels', load: async () => (await import('./DocPanels')).ChannelsPanel },
  { id: 'paths', title: 'Paths', load: async () => (await import('./DocPanels')).PathsPanel },
  { id: 'brushes', title: 'Brushes', load: async () => (await import('./MiscPanels')).BrushesPanel },
  { id: 'brushSettings', title: 'Brush Settings', load: async () => (await import('./MiscPanels')).BrushSettingsPanel },
  { id: 'character', title: 'Character', load: async () => (await import('./MiscPanels')).CharacterPanel },
  { id: 'paragraph', title: 'Paragraph', load: async () => (await import('./MiscPanels')).ParagraphPanel },
  { id: 'color', title: 'Color', load: async () => (await import('./ColorPanels')).ColorPanel },
  { id: 'swatches', title: 'Swatches', load: async () => (await import('./ColorPanels')).SwatchesPanel },
  { id: 'gradients', title: 'Gradients', load: async () => (await import('./ColorPanels')).GradientsPanel },
  { id: 'navigator', title: 'Navigator', load: async () => (await import('./ColorPanels')).NavigatorPanel },
  { id: 'info', title: 'Info', load: async () => (await import('./ColorPanels')).InfoPanel },
  { id: 'actions', title: 'Actions', load: async () => (await import('./MiscPanels')).ActionsPanel },
  { id: 'toolPresets', title: 'Tool Presets', load: async () => (await import('./MiscPanels')).ToolPresetsPanel },
  { id: 'compatibility', title: 'Compatibility Report', load: async () => (await import('./MiscPanels')).CompatibilityPanel },
];
