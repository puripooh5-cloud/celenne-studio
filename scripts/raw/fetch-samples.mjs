// Downloads the camera raw test samples listed in tests/fixtures/raw/samples.json (raw.pixls.us,
// CC0) into tests/fixtures/raw/, checking each file's SHA-256. Existing good files are kept.
//   node scripts/raw/fetch-samples.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = path.resolve('tests/fixtures/raw');
const { files } = JSON.parse(fs.readFileSync(path.join(dir, 'samples.json'), 'utf8'));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
let failed = 0;
for (const f of files) {
  const dest = path.join(dir, f.file);
  if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) === f.sha256) { console.log(`ok   ${f.file}`); continue; }
  process.stdout.write(`get  ${f.file} (${f.size}) … `);
  const res = await fetch(encodeURI(f.url), { headers: { 'User-Agent': 'Celenne-Studio-tests (+https://raw.pixls.us)' } });
  if (!res.ok) { console.log(`HTTP ${res.status}`); failed++; continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== f.sha256) { console.log('checksum mismatch, not saved'); failed++; continue; }
  fs.writeFileSync(dest, buf);
  console.log('done');
}
if (failed) { console.error(`${failed} file(s) failed`); process.exit(1); }
