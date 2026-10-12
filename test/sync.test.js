const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const S = require('../src/sync');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ethos-')); }
function put(p, txt) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); }

test('Modell aus dem Dateinamen', () => {
  assert.equal(S.modelOf('SB-10-2026-10-02-14-39-06.csv'), 'SB-10');
  assert.equal(S.modelOf('ASW-17-Thermik-2026-09-30-15-55-27.csv'), 'ASW-17-Thermik');
  assert.equal(S.modelOf('irgendwas.csv'), 'Ohne Modell');
  assert.equal(S.safeDir('A:B/C.'), 'A_B_C');
});

test('Sender über relativen Pfad und Laufwerksnamen finden', async () => {
  const root = tmp();
  put(path.join(root, 'USB1', 'Radio', 'logs', 'x.csv'), 'a');      // Ordner Radio/logs
  put(path.join(root, 'RADIO', 'logs', 'y.csv'), 'b');              // Laufwerk "RADIO" mit logs
  put(path.join(root, 'Fremd', 'logs', 'z.csv'), 'c');              // anderes Laufwerk mit logs: nicht nehmen
  const vols = ['USB1', 'RADIO', 'Fremd'].map(n => ({ root: path.join(root, n), label: n }));
  const dirs = await S.findSenderDirs('Radio/logs', vols);
  assert.deepEqual(dirs.sort(), [path.join(root, 'RADIO', 'logs'), path.join(root, 'USB1', 'Radio', 'logs')].sort());
  assert.deepEqual(await S.findSenderDirs(path.join(root, 'Fremd', 'logs'), vols), [path.join(root, 'Fremd', 'logs')]);
});

test('Sync kopiert nur neue Logs, ein Ordner pro Modell', async () => {
  const src = tmp(), arc = tmp();
  put(path.join(src, 'SB-10-2026-10-02-14-39-06.csv'), 'eins');
  put(path.join(src, 'Ka6-2026-08-15-09-30-00.csv'), 'zwei');
  put(path.join(src, 'notiz.txt'), 'x');
  const prog = [];
  let r = await S.syncDir(src, arc, p => prog.push(p));
  assert.equal(r.copied.length, 2);
  assert.ok(fs.existsSync(path.join(arc, 'SB-10', 'SB-10-2026-10-02-14-39-06.csv')));
  assert.ok(fs.existsSync(path.join(arc, 'Ka6', 'Ka6-2026-08-15-09-30-00.csv')));
  assert.ok(prog.some(p => p.file));
  r = await S.syncDir(src, arc);
  assert.equal(r.copied.length, 0); assert.equal(r.skipped, 2);
  put(path.join(src, 'SB-10-2026-10-03-10-00-00.csv'), 'drei');
  r = await S.syncDir(src, arc);
  assert.deepEqual(r.copied.map(c => c.name), ['SB-10-2026-10-03-10-00-00.csv']);
  const list = await S.listArchive(arc);
  assert.equal(list.length, 3);
  assert.ok(!fs.readdirSync(path.join(arc, 'SB-10')).some(n => n.endsWith('.part')));
});

test('Manuell eingelesenes Log ins Archiv', async () => {
  const arc = tmp();
  const a = await S.archiveFile(arc, 'SB-10-2026-10-02-14-39-06.csv', Buffer.from('abc'));
  assert.equal(a.existed, false);
  const b = await S.archiveFile(arc, 'SB-10-2026-10-02-14-39-06.csv', Buffer.from('abc'));
  assert.equal(b.existed, true);
});

test('Watcher synchronisiert einmal pro Anschluss', async () => {
  const root = tmp(), arc = tmp();
  const vol = { root: path.join(root, 'RADIO'), label: 'RADIO' };
  let plugged = false;
  const w = new S.SyncWatcher(() => ({ senderPath: 'Radio/logs', archiveDir: arc, autoSync: true }), { volumes: async () => plugged ? [vol] : [] });
  const states = []; w.on('status', s => states.push(s.state));
  assert.equal((await w.poll()).state, 'idle');
  put(path.join(vol.root, 'logs', 'SB-10-2026-10-02-14-39-06.csv'), 'x'); plugged = true;
  let s = await w.poll();
  assert.equal(s.state, 'done'); assert.equal(s.copied.length, 1);
  await w.poll(); assert.equal(states.filter(x => x === 'done').length, 1, 'kein zweiter Sync, solange angeschlossen');
  plugged = false; s = await w.poll(); assert.equal(s.connected, false);
  put(path.join(vol.root, 'logs', 'SB-10-2026-10-04-08-00-00.csv'), 'y'); plugged = true;
  s = await w.poll(); assert.equal(s.copied.length, 1, 'neuer Anschluss, neues Log');
});

test('Ohne Berechtigung wird ein Laufwerk nicht dauernd neu angefragt', async () => {
  const root = tmp();
  const vol = { root: path.join(root, 'RADIO'), label: 'RADIO' };
  fs.mkdirSync(path.join(vol.root, 'logs'), { recursive: true });
  fs.chmodSync(vol.root, 0o000);
  const asRoot = process.getuid && process.getuid() === 0;
  await S.findSenderDirs('Radio/logs', [vol]);
  if (!asRoot) assert.ok(S.denied.get(vol.root) > Date.now(), 'Pause gesetzt');
  fs.chmodSync(vol.root, 0o755);
  if (!asRoot) {
    assert.deepEqual(await S.findSenderDirs('Radio/logs', [vol]), [], 'während der Pause nicht anfassen');
    assert.deepEqual(await S.findSenderDirs('Radio/logs', [vol], true), [path.join(vol.root, 'logs')], 'Jetzt synchronisieren fragt sofort');
  }
  S.denied.clear();
});

test('Verweigerter Zugriff bricht den Sync ab, statt jede Datei zu versuchen', async () => {
  const root = tmp(), archive = path.join(root, 'Archiv');
  const vol = { root: path.join(root, 'RADIO'), label: 'RADIO' };
  const logs = path.join(vol.root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  for (const n of ['A-2026-01-01-10-00-00.csv', 'A-2026-01-02-10-00-00.csv', 'B-2026-01-03-10-00-00.csv']) fs.writeFileSync(path.join(logs, n), 'x');
  const calls = { stat: 0, copy: 0 };
  const fsp = fs.promises, orig = { stat: fsp.stat, copyFile: fsp.copyFile };
  const eperm = () => Object.assign(new Error('EPERM'), { code: 'EPERM' });
  fsp.stat = async p => { if (String(p).startsWith(logs + path.sep)) { calls.stat++; throw eperm(); } return orig.stat(p); };
  fsp.copyFile = async () => { calls.copy++; throw eperm(); };
  try {
    const w = new S.SyncWatcher(() => ({ autoSync: true, senderPath: 'Radio/logs', archiveDir: archive }), { volumes: async () => [vol] });
    const r = await w.poll();
    assert.equal(r.state, 'denied');
    assert.equal(calls.stat, 1, 'nach dem ersten Fehler aufgehört');
    assert.equal(calls.copy, 0);
    assert.ok(S.denied.get(vol.root) > Date.now(), 'Pause gesetzt');
    assert.equal((await w.poll()).state, 'denied', 'während der Pause wird nichts angefasst');
    assert.equal(calls.stat, 1);
    assert.ok(!w.synced.has(logs), 'gilt nicht als synchronisiert, wird später wiederholt');
  } finally { Object.assign(fsp, orig); S.denied.clear(); }
});

test('Sender während dem Sync abgezogen: Abbruch statt Fehler pro Datei', async () => {
  const root = tmp(), archive = path.join(root, 'Archiv');
  const vol = { root: path.join(root, 'RADIO'), label: 'RADIO' };
  const logs = path.join(vol.root, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const names = ['A-2026-01-01-10-00-00.csv', 'A-2026-01-02-10-00-00.csv', 'B-2026-01-03-10-00-00.csv', 'B-2026-01-04-10-00-00.csv'];
  for (const n of names) fs.writeFileSync(path.join(logs, n), 'x');
  const fsp = fs.promises, orig = fsp.copyFile;
  let n = 0;
  // nach der ersten Datei wird der Sender abgezogen
  fsp.copyFile = async (a, b) => { if (++n === 2) fs.rmSync(vol.root, { recursive: true, force: true }); return orig(a, b); };
  try {
    const w = new S.SyncWatcher(() => ({ autoSync: true, senderPath: 'Radio/logs', archiveDir: archive }), { volumes: async () => [vol] });
    const r = await w.poll();
    assert.equal(r.state, 'done');
    assert.equal(r.interrupted, true);
    assert.equal(r.copied.length, 1);
    assert.equal(r.errors.length, 0, 'kein Fehler pro Datei');
    assert.equal(r.left, 3);
    assert.equal(r.connected, false);
    assert.ok(!w.synced.has(logs), 'beim nächsten Anschliessen wird weiter synchronisiert');
    const left = fs.readdirSync(archive, { recursive: true }).filter(f => f.endsWith('.part'));
    assert.deepEqual(left, [], 'keine halben Dateien im Archiv');
  } finally { fsp.copyFile = orig; }
});

test('Jeti-Sender finden und Logs mit Datum im Namen ins Archiv kopieren', async () => {
  const root = tmp(), arc = tmp();
  put(path.join(root, 'JETI', 'Log', '20261007', '16-00-25.log'), '# YES V1\n');
  put(path.join(root, 'JETI', 'Log', '20261007', 'notiz.txt'), 'x');
  put(path.join(root, 'JETI', 'Log', '20261012', '14-05-33.log'), '# YES V1\nzwei');
  put(path.join(root, 'USB', 'Log', 'irgendwas.log'), 'kein Jeti');     // ohne Tagesordner: nicht nehmen
  const vols = ['JETI', 'USB'].map(n => ({ root: path.join(root, n), label: n }));
  const dirs = await S.findJetiDirs(vols);
  assert.deepEqual(dirs, [path.join(root, 'JETI', 'Log')]);
  let r = await S.syncDir(dirs[0], arc, () => {}, true);
  assert.equal(r.copied.length, 2);
  assert.ok(fs.existsSync(path.join(arc, 'Jeti', 'Jeti-2026-10-07-16-00-25.log')));
  assert.ok(fs.existsSync(path.join(arc, 'Jeti', 'Jeti-2026-10-12-14-05-33.log')));
  r = await S.syncDir(dirs[0], arc, () => {}, true);
  assert.equal(r.copied.length, 0);
  assert.equal(r.skipped, 2);
  const list = await S.listArchive(arc);
  assert.deepEqual(list.map(f => f.name).sort(), ['Jeti-2026-10-07-16-00-25.log', 'Jeti-2026-10-12-14-05-33.log']);
});

test('Text als UTF-8 oder Latin-1 lesen', () => {
  assert.equal(S.decodeText(Buffer.from('Höhe;°C', 'utf8')), 'Höhe;°C');
  assert.equal(S.decodeText(Buffer.from('Track;°\nTemp;°C\n', 'latin1')), 'Track;°\nTemp;°C\n');
  // abgeschnittenes UTF-8-Zeichen am Ende eines Ausschnitts bleibt UTF-8
  const b = Buffer.from('Abc;Höhe;Zeit;ä', 'utf8');
  assert.ok(S.decodeText(b.subarray(0, b.length - 1)).startsWith('Abc;Höhe'));
});

test('Polaren fürs MacCready-Widget neben die Logs schreiben', async () => {
  const root = tmp();
  const txt = '-- Test\nreturn {\n  ["SB-10"] = { a = -0.0072, b = 0.162, c = -1.51, vMin = 6.7, vMax = 18.9 },\n}\n';
  const dest = await S.writePolars(root, txt);
  assert.equal(dest, path.join(root, 'scripts', 'maccready', 'polaren.lua'));
  assert.equal(fs.readFileSync(dest, 'utf8'), txt);
  await S.writePolars(root, '-- neu\n');              // überschreibt
  assert.equal(fs.readFileSync(dest, 'utf8'), '-- neu\n');
  await assert.rejects(S.writePolars(root, 'os.remove("x")'));
});

test('Watcher merkt sich den Ethos-Ordner für polaren.lua', async () => {
  const root = tmp(), arc = tmp();
  put(path.join(root, 'RADIO', 'logs', 'SB-10-2026-10-02-14-39-06.csv'), 'a');
  const w = new S.SyncWatcher(() => ({ senderPath: 'Radio/logs', archiveDir: arc, autoSync: true }),
    { volumes: async () => [{ root: path.join(root, 'RADIO'), label: 'RADIO' }] });
  await w.poll(true);
  assert.deepEqual(w.ethosRoots, [path.join(root, 'RADIO')]);
});
