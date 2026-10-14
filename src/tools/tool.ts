/** Tool framework: tools receive document-space pointer events and may draw screen overlays. */
import type { Editor } from '../app/editor';
import type { DocumentSession } from '../app/session';
import type { ToolId } from './toolTypes';

export interface ToolPointer {
  /** Document coordinates (float). */
  x: number;
  y: number;
  /** Screen (CSS px, relative to the canvas element). */
  sx: number;
  sy: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  twist: number;
  button: number;
  buttons: number;
  shift: boolean;
  alt: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  mod: boolean;
  pointerType: string;
  time: number;
  clickCount: number;
}

export interface ToolHost {
  editor: Editor;
  session: DocumentSession;
  /** Requests an overlay repaint. */
  redraw(): void;
  setCursor(css: string): void;
  viewportSize(): { w: number; h: number };
}

export interface Tool {
  id: ToolId;
  activate?(h: ToolHost): void;
  deactivate?(h: ToolHost): void;
  down?(h: ToolHost, p: ToolPointer): void;
  move?(h: ToolHost, p: ToolPointer): void;
  up?(h: ToolHost, p: ToolPointer): void;
  /** Pointer moves with no button pressed. */
  hover?(h: ToolHost, p: ToolPointer): void;
  doubleClick?(h: ToolHost, p: ToolPointer): void;
  keyDown?(h: ToolHost, e: KeyboardEvent): boolean;
  keyUp?(h: ToolHost, e: KeyboardEvent): boolean;
  /** Cancels an in-progress interaction (Esc, tool switch). */
  cancel?(h: ToolHost): void;
  /** Commits an in-progress interaction (Enter). */
  commit?(h: ToolHost): void;
  cursor?(h: ToolHost, p: ToolPointer | null): string;
  /** Screen-space overlay drawing (context is in CSS px, DPR handled by the caller). */
  drawOverlay?(h: ToolHost, g: CanvasRenderingContext2D): void;
  /** True while the tool is dragging/drawing (blocks tool switching side effects). */
  busy?(): boolean;
}
