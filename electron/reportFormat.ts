/**
 * Error reports: what is collected, how it is scrubbed, and the wire format.
 *
 * A report holds the error type and message, the stack trace (code locations inside the app),
 * the app / Electron / Windows versions and, when a document is open, its file format, colour
 * mode and bit depth. It never holds document pixels, layer names, text or file names: paths,
 * file names, quoted strings, e-mail addresses, URL queries and the Windows user and computer
 * names are removed from every message and stack line before a report is stored.
 * Reports are sent in the Sentry envelope format, which Sentry and GlitchTip both accept.
 * Pure Node code (no Electron) so it is unit-tested directly.
 */
import crypto from 'node:crypto';

export interface ReportContext {
  appVersion: string;
  electron: string;
  chrome: string;
  os: string;
  osVersion: string;
  arch: string;
  /** Viewport renderer in use (webgpu / webgl2 / canvas2d), when known. */
  renderer?: string;
  document?: { format?: string; mode?: string; depth?: number };
}

export interface ErrorReport {
  id: string;
  created: string;
  kind: 'error' | 'crash';
  /** Where it happened: main process, editor (renderer), GPU or another helper process. */
  process: string;
  type: string;
  message: string;
  stack: string[];
  /** For crashes: Chromium's reason and exit code. */
  reason?: string;
  exitCode?: number;
  /** How often this same problem happened in the session that recorded it. */
  count: number;
  fingerprint: string;
  context: ReportContext;
  sent?: string;
}

export interface ScrubOptions {
  /** Windows user and computer names (removed wherever they appear). */
  names?: string[];
}

const DOC_EXT = 'psd|psb|png|jpe?g|jpe|jfif|tiff?|gif|webp|bmp|heic|heif|avif|dng|cr2|cr3|crw|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|srw|x3f|3fr|iiq|pdf|svg|ico|exr|hdr|tga|ppm|pgm|pbm|pnm|json|lplugin|atn|abr|aco|ase|grd|pat|icc|icm|zip|txt|csv|ai|eps';

/** Removes anything that could identify a person, a file or document content. */
export function scrub(input: string, opts: ScrubOptions = {}): string {
  let s = String(input ?? '');
  // App code locations stay useful: "...\resources\app.asar\dist-electron\main.cjs" → "app.asar/dist-electron/main.cjs".
  s = s.replace(/(?:[A-Za-z]:)?[^\s"'()<>]*?app\.asar((?:[\\/][\w.-]+)*)/g, (_m, rest: string) => `app.asar${rest.replace(/\\/g, '/')}`);
  s = s.replace(/file:\/\/[^\s"')<>]+/gi, '<path>');
  s = s.replace(/https?:\/\/[^\s"'<>]+/gi, (u) => {
    if (/^app:\/\//i.test(u)) return u;
    const q = u.search(/[?#]/);
    return q >= 0 ? `${u.slice(0, q)}?<removed>` : u;
  });
  s = s.replace(/"[^"\n]{0,400}"/g, '"<removed>"').replace(/[“‘][^”’\n]{0,400}[”’]/g, '“<removed>”');
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>');
  // Folder and file names can contain spaces, so a path runs to the next quote, bracket or line end.
  s = s.replace(/\\\\[^"'()<>|\n]+/g, '<path>'); // UNC
  s = s.replace(/\b[A-Za-z]:[\\/][^"'()<>|*?\n]*/g, '<path>');
  s = s.replace(/(^|[\s(=:'])\/(?:Users|home|tmp|var|private|Volumes|mnt|media|root|opt|srv)\/[^"'()<>|\n]*/g, '$1<path>');
  s = s.replace(/[^\s"'<>]*\\[^\s"'<>]*/g, (m) => (m.startsWith('app.asar') ? m : '<path>'));
  s = s.replace(new RegExp(`[^\\s"'<>/\\\\()]+\\.(?:${DOC_EXT})\\b`, 'gi'), (m) => (/^(?:main|preload)\.cjs$/i.test(m) ? m : '<file>'));
  for (const n of opts.names ?? []) {
    if (!n || n.length < 3) continue;
    s = s.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<name>');
  }
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}

export function scrubStack(stack: string | undefined, opts: ScrubOptions = {}): string[] {
  if (!stack) return [];
  return stack.split('\n').slice(1).map((l) => l.trim()).filter((l) => l.startsWith('at ')).slice(0, 40).map((l) => scrub(l, opts).slice(0, 300));
}

export function makeReport(input: { kind: ErrorReport['kind']; process: string; type?: string; message?: string; stack?: string; reason?: string; exitCode?: number }, context: ReportContext, opts: ScrubOptions = {}): ErrorReport {
  const type = scrub(input.type || (input.kind === 'crash' ? 'ProcessCrash' : 'Error'), opts).slice(0, 80);
  const message = scrub(input.message ?? '', opts);
  const stack = scrubStack(input.stack, opts);
  const fingerprint = crypto.createHash('sha256').update(`${input.process}|${type}|${message.replace(/\d+/g, '#')}|${stack[0] ?? ''}|${input.reason ?? ''}`).digest('hex').slice(0, 16);
  return {
    id: crypto.randomUUID().replace(/-/g, ''),
    created: new Date().toISOString(),
    kind: input.kind,
    process: input.process,
    type,
    message,
    stack,
    reason: input.reason,
    exitCode: input.exitCode,
    count: 1,
    fingerprint,
    context: sanitizeContext(context),
  };
}

function sanitizeContext(c: ReportContext): ReportContext {
  const word = (v: unknown, max = 24) => (typeof v === 'string' && /^[\w .()+-]*$/.test(v) ? v.slice(0, max) : undefined);
  const d = c.document;
  return {
    appVersion: word(c.appVersion) ?? '?', electron: word(c.electron) ?? '?', chrome: word(c.chrome) ?? '?',
    os: word(c.os) ?? '?', osVersion: word(c.osVersion) ?? '?', arch: word(c.arch) ?? '?', renderer: word(c.renderer),
    document: d ? { format: word(d.format, 8)?.toLowerCase(), mode: word(d.mode, 16), depth: typeof d.depth === 'number' && [1, 8, 16, 32].includes(d.depth) ? d.depth : undefined } : undefined,
  };
}

/** The text shown in "View report": exactly what would be sent. */
export function reportText(r: ErrorReport): string {
  return JSON.stringify(sentryEvent(r), null, 2);
}

export interface Dsn { key: string; envelopeUrl: string; raw: string }

/**
 * Parses a Sentry / GlitchTip DSN (https://<key>@<host>[/<path>]/<project>). Plain HTTP is accepted
 * only for a loopback test receiver in test builds.
 */
export function parseDsn(dsn: string, allowLoopbackHttp = false): Dsn | null {
  try {
    const u = new URL(dsn);
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (!(u.protocol === 'https:' || (allowLoopbackHttp && loopback && u.protocol === 'http:')) || !u.username) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const project = parts.pop();
    if (!project || !/^\d+$/.test(project)) return null;
    const prefix = parts.length ? `/${parts.join('/')}` : '';
    return { key: u.username, envelopeUrl: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`, raw: dsn };
  } catch {
    return null;
  }
}

function frames(stack: string[]) {
  // V8 lines: "at fn (file:line:col)" or "at file:line:col". Sentry wants the innermost frame last.
  return stack.map((l) => {
    const m = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(l);
    return m ? { function: m[1] ?? '?', filename: m[2], lineno: Number(m[3]), colno: Number(m[4]), in_app: true } : { function: l.slice(3), in_app: true };
  }).reverse();
}

export function sentryEvent(r: ErrorReport) {
  const c = r.context;
  return {
    event_id: r.id,
    timestamp: Date.parse(r.created) / 1000,
    platform: 'javascript',
    level: r.kind === 'crash' ? 'fatal' : 'error',
    release: `celenne-studio@${c.appVersion}`,
    environment: 'production',
    exception: { values: [{ type: r.type, value: r.message || (r.reason ? `Process ended: ${r.reason}` : ''), stacktrace: r.stack.length ? { frames: frames(r.stack) } : undefined }] },
    tags: {
      process: r.process, renderer: c.renderer, reason: r.reason,
      doc_format: c.document?.format, doc_mode: c.document?.mode, doc_depth: c.document?.depth != null ? String(c.document.depth) : undefined,
    },
    contexts: {
      os: { name: c.os, version: c.osVersion },
      runtime: { name: 'Electron', version: c.electron },
      browser: { name: 'Chrome', version: c.chrome },
      app: { app_version: c.appVersion },
      device: { arch: c.arch },
    },
    extra: { occurrences: r.count, exit_code: r.exitCode },
    fingerprint: [r.fingerprint],
  };
}

export function sentryEnvelope(r: ErrorReport, dsn: Dsn): { url: string; headers: Record<string, string>; body: string } {
  const header = { event_id: r.id, sent_at: new Date().toISOString() };
  return {
    url: dsn.envelopeUrl,
    headers: {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=celenne-studio/${r.context.appVersion}, sentry_key=${dsn.key}`,
    },
    body: `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(sentryEvent(r))}\n`,
  };
}
