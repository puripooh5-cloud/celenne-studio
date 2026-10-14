let counter = 0;
const session = Math.random().toString(36).slice(2, 7);

/** Short unique ids: `<prefix>-<session>-<counter>`; stable within a session and collision-free across documents. */
export function newId(prefix = 'id'): string {
  counter++;
  return `${prefix}-${session}-${counter.toString(36)}`;
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
