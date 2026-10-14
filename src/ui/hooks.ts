/** React hooks bridging the editor core and components (narrow subscriptions). */
import { useEffect, useReducer, useRef } from 'react';
import { useApp } from '../app/store';
import { editor } from '../app/editor';
import type { DocumentSession } from '../app/session';

/** Active session; re-renders when documents or their structure change. */
export function useSession(): DocumentSession | null {
  useApp((s) => s.activeSessionId);
  useApp((s) => s.docRev);
  return editor.active;
}

export function useHistoryRev(): number {
  return useApp((s) => s.historyRev);
}

export function useViewRev(): number {
  return useApp((s) => s.viewRev);
}

export function useForceUpdate(): () => void {
  const [, f] = useReducer((x: number) => x + 1, 0);
  return f;
}

/** Runs `fn` on animation frames while mounted. */
export function useAnimationFrame(fn: (t: number) => void, active = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const loop = (t: number) => {
      ref.current(t);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [active]);
}
