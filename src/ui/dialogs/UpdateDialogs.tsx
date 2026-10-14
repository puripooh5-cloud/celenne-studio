/**
 * Check for Updates, Error Reports and the "send this report?" prompt (desktop app).
 * The browser build has neither feature and says so instead of showing inert controls.
 */
import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Check, Select } from '../controls';
import { ui } from '../../app/store';
import { restartToUpdate, useUpdates } from '../../app/updates';
import type { ReportMode, ReportsStatus, ReportSummary } from '../../app/platform/bridge';

const bridge = () => window.celenne;
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '');

export function UpdatesDialog({ close }: { close: () => void }) {
  const b = bridge();
  const s = useUpdates((x) => x.state);
  useEffect(() => { void b?.updates.state().then((st) => useUpdates.setState({ state: st })); }, [b]);
  if (!b?.updates) {
    return (
      <Modal title="Check for Updates" onClose={close} noFooter width={460}>
        <p>Updates are available in the desktop app. This browser build always runs the version it was served with.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={close}>Close</button></div>
      </Modal>
    );
  }
  const busy = s && ['checking', 'downloading', 'verifying'].includes(s.status);
  const canCheck = s && !busy && s.status !== 'disabled' && s.status !== 'ready';
  let headline = '';
  if (!s) headline = 'Loading…';
  else if (s.status === 'disabled') headline = s.reason ?? 'Updates are off for this build.';
  else if (s.status === 'idle') headline = 'Not checked yet.';
  else if (s.status === 'checking') headline = 'Checking for updates…';
  else if (s.status === 'none') headline = `Celenne Studio ${s.current} is the latest version.`;
  else if (s.status === 'downloading') headline = `Downloading version ${s.version}… ${s.percent ?? 0}%`;
  else if (s.status === 'verifying') headline = `Checking the signature of version ${s.version}…`;
  else if (s.status === 'ready') headline = `Version ${s.version} is downloaded and verified. It installs when you quit Celenne Studio.`;
  else if (s.status === 'available') headline = `Version ${s.version} is available.`;
  else if (s.status === 'error') headline = s.error ?? 'The update check failed.';
  return (
    <Modal title="Check for Updates" onClose={close} noFooter width={520}>
      <div className="faint">Installed version {s?.current ?? __APP_VERSION__}{s?.portable ? ' (portable)' : ''}{s?.lastChecked ? ` · last checked ${when(s.lastChecked)}` : ''}</div>
      <p style={{ fontWeight: 600 }} role="status">{headline}</p>
      {s?.status === 'downloading' && <progress max={100} value={s.percent ?? 0} style={{ width: '100%' }} />}
      {s?.status === 'available' && s.portable && <p className="faint">A portable copy cannot replace itself, and new versions come as a setup file only. Install the setup version to get this and later updates automatically.</p>}
      {s?.notes && (
        <>
          <div className="section-title">What's new in {s.version}</div>
          <pre className="release-notes" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', margin: 0, font: 'inherit' }}>{s.notes}</pre>
        </>
      )}
      {s && s.status !== 'disabled' && (
        <div style={{ marginTop: 10 }}>
          <Check label="Check for updates automatically" checked={s.autoCheck} onChange={(v) => void b.updates.setAutoCheck(v).then(() => b.updates.state()).then((st) => useUpdates.setState({ state: st }))} />
          <div className="faint">Checking sends only a request for the release information; no document or personal data is sent. Updates download in the background and install when you quit.</div>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        {s?.status === 'available' && s.downloadUrl && <button className="btn primary" onClick={() => void b.openExternal(s.downloadUrl!)}>Download…</button>}
        {s?.status === 'ready' && <button className="btn primary" onClick={() => { close(); void restartToUpdate(); }}>Restart Now</button>}
        {canCheck && <button className="btn" onClick={() => void b.updates.check()}>Check Now</button>}
        <button className="btn" onClick={close}>Close</button>
      </div>
    </Modal>
  );
}

const MODE_OPTIONS: { value: ReportMode; label: string }[] = [
  { value: 'ask', label: 'Ask each time' },
  { value: 'always', label: 'Always send' },
  { value: 'never', label: 'Never send' },
];

/** What a report contains: shown wherever the user decides about sending. */
export function ReportPrivacyNote() {
  return (
    <div className="faint">
      A report contains the error message and code locations, the app, Electron and Windows versions, the renderer, and the open document's file type, colour mode and bit depth.
      It never contains the image, layer names, text, file names or folder paths; those are removed before a report is saved.
      Crash dumps stay on this computer.
    </div>
  );
}

export function ErrorReportsDialog({ close }: { close: () => void }) {
  const b = bridge();
  const [status, setStatus] = useState<ReportsStatus | null>(null);
  const [list, setList] = useState<ReportSummary[] | null>(null);
  const [viewing, setViewing] = useState<{ id: string; text: string } | null>(null);
  const refresh = async () => {
    if (!b?.reports) return;
    setStatus(await b.reports.status());
    setList(await b.reports.list());
  };
  useEffect(() => { void refresh(); }, []);
  if (!b?.reports) {
    return (
      <Modal title="Error Reports" onClose={close} noFooter width={460}>
        <p>Error reports are available in the desktop app.</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={close}>Close</button></div>
      </Modal>
    );
  }
  const send = async (ids: string[] | 'unsent') => {
    const r = await b.reports.send(ids);
    if (r.error && !r.sent) ui.toast('error', 'Reports were not sent', r.error);
    else ui.toast('success', `Sent ${r.sent} report${r.sent === 1 ? '' : 's'}. Thank you.`, r.error);
    await refresh();
  };
  return (
    <Modal title="Error Reports" onClose={close} noFooter width={640}>
      {status && (
        <div className="grid2">
          <span className="lbl" style={{ alignSelf: 'start', paddingTop: 4 }}>Send reports</span>
          <div>
            <Select value={status.mode} onChange={async (m) => setStatus(await b.reports.setMode(m))} options={MODE_OPTIONS} />
            <div className="faint">{status.destination ? `Reports go to ${status.destination}.` : 'This build has no report destination, so reports are only kept on this computer.'}</div>
          </div>
        </div>
      )}
      <ReportPrivacyNote />
      <div className="section-title">Saved reports</div>
      {list === null ? <div className="faint">Loading…</div> : list.length === 0 ? <div className="faint">No reports. Celenne Studio has not recorded any errors.</div> : (
        <div style={{ maxHeight: 220, overflow: 'auto' }}>
          <table className="kv-table">
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="faint" style={{ width: 150 }}>{when(r.created)}</td>
                  <td>{r.kind === 'crash' ? 'Crash' : 'Error'} in {r.process}: {r.type}{r.message ? ` — ${r.message.slice(0, 90)}` : ''}{r.count > 1 ? ` (×${r.count})` : ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {r.sent ? <span className="faint">Sent</span> : status?.destination && <button className="btn small" onClick={() => void send([r.id])}>Send</button>}
                    {' '}<button className="btn small" onClick={async () => setViewing({ id: r.id, text: (await b.reports.view(r.id)) ?? '' })}>View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {viewing && (
        <>
          <div className="section-title">Report {viewing.id.slice(0, 8)} — exactly what would be sent</div>
          <pre className="mono" style={{ maxHeight: 220, overflow: 'auto', margin: 0, fontSize: 11, whiteSpace: 'pre-wrap' }}>{viewing.text}</pre>
        </>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => void b.reports.openFolder('reports')}>Open Reports Folder</button>
        <button className="btn" onClick={() => void b.reports.openFolder('dumps')}>Open Crash Dumps Folder</button>
        {!!list?.length && <button className="btn" onClick={async () => { setStatus(await b.reports.discard('all')); setViewing(null); await refresh(); }}>Delete All</button>}
        {!!status?.destination && !!status.unsent && <button className="btn primary" onClick={() => void send('unsent')}>Send Unsent ({status.unsent})</button>}
        <button className="btn" onClick={close}>Close</button>
      </div>
    </Modal>
  );
}

/** Shown once per session when a new report exists and the user chose "Ask each time". */
export function ReportPromptDialog({ close, status }: { close: () => void; status: ReportsStatus }) {
  const b = bridge()!;
  const [remember, setRemember] = useState(false);
  const decide = async (sendIt: boolean) => {
    if (remember) await b.reports.setMode(sendIt ? 'always' : 'never');
    if (sendIt && !remember) {
      const r = await b.reports.send('unsent');
      if (r.error && !r.sent) ui.toast('error', 'The report was not sent', r.error);
    }
    close();
  };
  return (
    <Modal title="Celenne Studio ran into a problem" onClose={close} noFooter width={520}>
      <p>An error report was saved{status.unsent > 1 ? ` (${status.unsent} unsent)` : ''}. Sending it to {status.destination} helps fix the problem.</p>
      <ReportPrivacyNote />
      <div style={{ marginTop: 10 }}><Check label="Remember my choice" checked={remember} onChange={setRemember} /></div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button className="btn" onClick={() => { close(); ui.openDialog('reports'); }}>View Report…</button>
        <button className="btn" onClick={() => void decide(false)}>Don't Send</button>
        <button className="btn primary" onClick={() => void decide(true)}>Send</button>
      </div>
    </Modal>
  );
}

/** Preferences ▸ Updates & Privacy. These settings belong to the desktop host and apply at once. */
export function UpdatePrivacyPrefs() {
  const b = bridge();
  const s = useUpdates((x) => x.state);
  const [rs, setRs] = useState<ReportsStatus | null>(null);
  useEffect(() => { void b?.reports?.status().then(setRs); void b?.updates?.state().then((st) => useUpdates.setState({ state: st })); }, [b]);
  if (!b?.updates) return <div className="faint">Updates and error reports are available in the desktop app.</div>;
  return (
    <div className="grid2">
      <span className="lbl" style={{ alignSelf: 'start', paddingTop: 4 }}>Updates</span>
      <div>
        {s?.status === 'disabled' ? <div className="faint">{s.reason}</div> : (
          <Check label="Check for updates automatically" checked={!!s?.autoCheck} onChange={(v) => void b.updates.setAutoCheck(v).then(() => b.updates.state()).then((st) => useUpdates.setState({ state: st }))} />
        )}
        <div className="faint"><a href="#" onClick={(e) => { e.preventDefault(); ui.openDialog('updates'); }}>Check for Updates…</a></div>
      </div>
      <span className="lbl" style={{ alignSelf: 'start', paddingTop: 4 }}>Error reports</span>
      <div>
        {rs && <Select value={rs.mode} onChange={async (m) => setRs(await b.reports.setMode(m))} options={MODE_OPTIONS} />}
        <div className="faint">{rs?.destination ? `Reports go to ${rs.destination}.` : 'This build has no report destination, so reports are only kept on this computer.'} <a href="#" onClick={(e) => { e.preventDefault(); ui.openDialog('reports'); }}>Error Reports…</a></div>
        <div style={{ marginTop: 6 }}><ReportPrivacyNote /></div>
      </div>
      <span className="lbl" />
      <div className="faint">These settings apply immediately.</div>
    </div>
  );
}
