/** In-app replacements for window.prompt / window.confirm (unsupported in Electron). */
import { ui } from '../app/store';
import { platform } from '../app/platform/platform';

export function promptText(title: string, value = '', label = 'Name'): Promise<string | null> {
  return new Promise((resolve) => ui.openDialog('prompt', { title, value, label, resolve }));
}

export async function confirmAction(message: string, detail?: string, ok = 'OK'): Promise<boolean> {
  return (await platform().confirm(message, detail, [ok, 'Cancel'])) === 0;
}
