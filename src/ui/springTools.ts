import type { ToolId } from '../tools/toolTypes';

/** Temporary tool switches while modifier keys are held. */
export const ALL_SPRING = {
  /** Tools where holding Alt samples a color with the eyedropper. */
  altEyedropper: ['brush', 'pencil', 'paintBucket', 'gradient', 'rectangle', 'ellipse', 'polygon', 'line', 'customShape'] as ToolId[],
};
