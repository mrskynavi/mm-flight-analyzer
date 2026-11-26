const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const HG = require('../src/hangar');
const S = require('../src/sync');
const SN = require('../src/skynav');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-')); }
function put(p, txt) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); }

test('Modell-ID: eine Regel mit Bindestrich (wie hangar-sync)', () => {
  assert.equal(HG.modelId('ASW-17'), 'ASW-17');
  assert.equal(HG.modelId('ASW_17'), 'ASW-17');
  assert.equal(HG.modelId('ASW 17'), 'ASW-17');
  assert.equal(HG.modelId('Neues--Modell'), 'Neues-Modell');
  assert.equal(HG.modelId('Flügel v4 (AG-35)'), 'Fluegel-v4-AG-35');
});

test('Hangar in Google Drive „Meine Ablage“ finden, sonst ~/MM-Hangar', () => {
  const home = tmp();
  assert.equal(HG.defaultHangar(home, 'darwin'), path.join(home, 'MM-Hangar'));
  const my = path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-a@b.ch', 'Meine Ablage');
  fs.mkdirSync(my, { recursive: true });
  assert.equal(HG.defaultHangar(home, 'darwin'), path.join(my, 'MM-Hangar'));
});

test('Altes Archiv einmal in den Hangar kopieren, Quelle bleibt', async () => {
  const old = tmp(), hangar = path.join(tmp(), 'MM-Hangar');
  put(path.join(old, 'ASW-17', 'ASW-17-2026-11-24-15-28-55.csv'), 'Date,Time\n1,2\n');
  put(path.join(old, 'ASW_17', 'ASW_17-2026-10-01-10-00-00.csv'), 'Date,Time\n3,4\n');
  put(path.join(old, 'Jeti', 'Jeti-2026-11-01-10-00-00.log'), 'jeti');
  put(path.join(old, 'SkyNavigator', 'aufgaben.json'), JSON.stringify({ active: 'a', tasks: [{ id: 'a', name: 'Linth', codeBase: { lat: 47 } }] }));
  put(path.join(old, 'SkyNavigator', 'aufgaben.lua'), '-- x\nreturn {}\n');
  put(path.join(old, 'SkyNavigator', 'Fluege', '2026-11-24-XSN-SKYNAV-01.IGC'), 'AXSN\n');
  const rep = await HG.migrateArchive(old, hangar, { modelOf: S.modelOf, listArchive: S.listArchive });
  assert.equal(rep.logs, 3);
  assert.equal(rep.tasks, 1);
  assert.equal(rep.flights, 1);
  assert.ok(fs.existsSync(path.join(hangar, 'modelle', 'ASW-17', 'fluege', 'ASW-17-2026-11-24-15-28-55.csv')));
  assert.ok(fs.existsSync(path.join(hangar, 'modelle', 'ASW-17', 'fluege', 'ASW_17-2026-10-01-10-00-00.csv')), 'ASW_17 landet bei ASW-17');
  assert.ok(fs.existsSync(path.join(hangar, 'modelle', 'Jeti', 'fluege', 'Jeti-2026-11-01-10-00-00.log')));
  assert.ok(fs.existsSync(path.join(hangar, 'skynav', 'fluege', '2026-11-24-XSN-SKYNAV-01.IGC')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(hangar, 'hangar.json'), 'utf8')).format, 'mm-hangar');
  assert.ok(fs.existsSync(path.join(old, 'ASW-17', 'ASW-17-2026-11-24-15-28-55.csv')), 'Quelle unverändert');
  // zweimal: nichts Neues
  const rep2 = await HG.migrateArchive(old, hangar, { modelOf: S.modelOf, listArchive: S.listArchive });
  assert.equal(rep2.logs + rep2.tasks + rep2.flights, 0);
  // Der Hangar ist jetzt das Archiv: Liste und SkyNavigator-Pfade
  assert.equal(HG.isHangar(hangar), true);
  assert.equal((await S.listArchive(hangar)).length, 3);
  assert.equal(SN.flightDir(hangar), path.join(hangar, 'skynav', 'fluege'));
  assert.equal((await SN.loadTasks(hangar)).tasks[0].codeBase.lat, 47);
});

test('Sync in den Hangar: modelle/<ID>/fluege, gelöschte IGC kommen nicht zurück', async () => {
  const hangar = tmp(), radio = tmp();
  await HG.ensureIndex(hangar);
  put(path.join(radio, 'logs', 'ASW 17-2026-11-24-15-28-55.csv'), 'Date,Time\n1,2\n');
  const r = await S.syncDir(path.join(radio, 'logs'), hangar);
  assert.equal(r.copied.length, 1);
  assert.equal(r.copied[0].path, path.join(hangar, 'modelle', 'ASW-17', 'fluege', 'ASW 17-2026-11-24-15-28-55.csv'));
  put(path.join(radio, 'scripts', 'skynav', 'fluege', 'A.IGC'), 'AXSN\n');
  put(path.join(hangar, 'skynav', 'fluege', 'Gelöscht', 'A.IGC'), 'AXSN\n');
  const f = await SN.copyFlights(radio, hangar);
  assert.equal(f.copied.length, 0);
  assert.equal(fs.existsSync(path.join(hangar, 'skynav', 'fluege', 'A.IGC')), false);
});

test('Sperrdatei: nur eine App holt gleichzeitig vom Sender', async () => {
  const hangar = tmp();
  fs.writeFileSync(path.join(hangar, HG.LOCK), JSON.stringify({ pid: 4242, app: 'SkyNavigator', createdAt: Date.now() }));
  const busy = await HG.acquireLock(hangar);
  assert.equal(busy.acquired, false);
  assert.match(busy.lockedBy, /SkyNavigator/);
  fs.writeFileSync(path.join(hangar, HG.LOCK), JSON.stringify({ pid: 4242, app: 'SkyNavigator', createdAt: Date.now() - 10 * 60 * 1000 }));
  assert.equal((await HG.acquireLock(hangar)).acquired, true, 'verwaiste Sperre (> 5 min) wird übernommen');
  await HG.releaseLock(hangar);
  assert.equal(fs.existsSync(path.join(hangar, HG.LOCK)), false);
});
