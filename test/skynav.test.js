const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SN = require('../src/skynav');

// Rechenteil des Tabs SkyNavigator direkt aus der Seite
const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const core = /<script id="skynavCore">([\s\S]*?)<\/script>/.exec(html)[1];
const SKY = new Function(core + ';return SKY;')();

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sky-'));
const put = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// kleiner IGC-Flug: Start aus dem Startsektor, drei Wendepunkte, Ziel, das Ganze zweimal
function igcFlight(task, laps = 2, entry = { agl: 380, kmh: 100 }) {
  const g = SKY.geom(task), L = ['AXSNSKYNAV', 'HFDTEDATE:151026,01', 'HFPLTPILOT:Test', 'HFCCLCOMPETITIONCLASS:SPORT', 'I013637SUS', 'LPilotID:x'];
  SKY.toRct(task).trim().split('\r\n').forEach(l => L.push('LTSK:' + l));
  let t = 10 * 3600;
  const fmt = (v, deg, h1, h2) => { const a = Math.abs(v), d = Math.floor(a), m = Math.round((a - d) * 60000); return String(d).padStart(deg, '0') + String(m).padStart(5, '0') + (v >= 0 ? h1 : h2); };
  const hms = s => [Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60].map(v => String(v).padStart(2, '0')).join('');
  const B = (x, y, agl) => { const [la, lo] = SKY.toLL(task, g, x, y); L.push('B' + hms(t) + fmt(la, 2, 'N', 'S') + fmt(lo, 3, 'E', 'W') + 'A' + String(Math.round(agl + task.elev)).padStart(5, '0').repeat(2) + '00'); t++; };
  const fly = (a, b, v, h0, h1) => { const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / v)); for (let i = 1; i <= n; i++) B(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n, h0 + (h1 - h0) * i / n); };
  const P = p => [p.x + p.bx * 30, p.y + p.by * 30];
  const s0 = [-200 * g.ux, -200 * g.uy], vEntry = entry.kmh / 3.6;
  B(s0[0] - vEntry * g.ux, s0[1] - vEntry * g.uy, entry.agl);
  L.push('E' + hms(t) + 'PEV');
  fly(s0, [-vEntry / 2 * g.ux, -vEntry / 2 * g.uy], vEntry, entry.agl, entry.agl);
  let pos = [-vEntry / 2 * g.ux, -vEntry / 2 * g.uy], h = entry.agl;
  for (let k = 0; k < laps; k++) {
    for (const c of g.tp) { const q = P(c); fly(pos, q, 25, h, h - 15); pos = q; h -= 15; }
    const fin = [g.px * 20 + g.ux * 20, g.py * 20 + g.uy * 20]; fly(pos, fin, 25, h, h - 5); pos = fin; h -= 5;
  }
  return L.join('\r\n') + '\r\n';
}

test('Geometrie: TP1 in Richtung alpha, TP2 bei alpha - 90, TP3 gegenüber, Umfang', () => {
  const t = { ...SKY.newTask('Sport'), dir: 0, dist: 350 };
  const g = SKY.geom(t);
  assert.ok(Math.abs(g.tp[0].x) < 1e-9 && Math.abs(g.tp[0].y - 350) < 1e-9);
  assert.ok(Math.abs(g.tp[1].x + 350) < 1e-9 && Math.abs(g.tp[1].y) < 1e-9);
  assert.ok(Math.abs(g.tp[2].y + 350) < 1e-9);
  assert.ok(Math.abs(g.perim - 350 * (2 + 2 * Math.SQRT2)) < 1e-9);
  // Sektor: 1.5 km, ±45° um die äussere Winkelhalbierende
  assert.ok(SKY.inSector(g.tp[1], -350 - 1000, 0));
  assert.ok(!SKY.inSector(g.tp[1], -350 + 10, 0));
  assert.ok(!SKY.inSector(g.tp[1], -350 - 1600, 0));
});

test('Strafe nach Reglement: 50 + 2 je Meter und je km/h darüber', () => {
  const t = SKY.newTask('Sport');
  assert.strictEqual(SKY.penaltyOf(t, 400, 120), 0);
  assert.strictEqual(SKY.penaltyOf(t, 410, 120), 70);
  assert.strictEqual(SKY.penaltyOf(t, 405, 125), 70);
});

test('.rct hin und zurück mit Zonen', () => {
  const t = { ...SKY.newTask('Light'), name: 'Platz, Nord', dir: 107, zones: [{ t: 'C', name: 'Parkplatz', lat: 47.2, lon: 8.9, r: 50, lo: 0, hi: 100 }, { t: 'R', name: 'Strasse', lat: 47.21, lon: 8.91, dir: 30, len: 300, wid: 40, lo: 0, hi: 9999 }] };
  const txt = SKY.toRct(t);
  assert.match(txt, /^V:02\.0\r\nT:Platz  Nord,47\.220500,8\.945500,400,107,200,250,70,10,20\r\n/);
  const b = SKY.fromRct(txt);
  assert.strictEqual(b.cls, 'Light');
  assert.strictEqual(b.zones.length, 2);
  assert.deepStrictEqual([b.zones[1].t, b.zones[1].dir, b.zones[1].len], ['R', 30, 300]);
  assert.throws(() => SKY.fromRct('V:02.0'));
});

test('aufgaben.lua: Startfenster in UTC, Texte sicher in Lua-Strings', () => {
  const t = { ...SKY.newTask('Sport'), id: 'a1', name: 'Schmerikon "Test"\\', slot: { date: '2026-10-15', time: '10:00', len: 20 } };
  const lua = SKY.toLua({ active: 'a1', pilot: 'Christoph', pilotId: '', tasks: [t] }, new Date('2026-10-15T08:00:00Z'));
  assert.ok(lua.startsWith('--'));
  assert.match(lua, /name = "Schmerikon \\"Test\\"\\\\"/);
  const s = SKY.slotUtc(t.slot), d = new Date('2026-10-15T10:00');
  assert.deepStrictEqual([s.h, s.mi, s.len], [d.getUTCHours(), d.getUTCMinutes(), 20]);
  assert.match(lua, /slot = \{y = 2026, mo = 10, d = \d+, h = \d+, mi = 0, len = 20\}/);
  assert.match(lua, /rct = "V:02\.0\\r\\nT:/);
});

test('Widget-Einstellungen: Bereich, Typ und Vorgaben in aufgaben.lua', () => {
  const st = SKY.settingsOf({ margin: 500, zoomSec: '7', sound: 'ja', compId: 'AB\u00e9C', radMode: 5, warnSec: 99 });
  assert.strictEqual(st.margin, 100);
  assert.strictEqual(st.zoomSec, 7);
  assert.strictEqual(st.sound, true);
  assert.strictEqual(st.compId, 'ABC');
  assert.strictEqual(st.radMode, undefined);
  assert.strictEqual(st.warnSec, 10);
  assert.strictEqual(st.varioTone, false);
  const lua = SKY.toLua({ tasks: [], settings: { margin: 12, navVoice: false, gliderId: 'HB-1' } });
  assert.match(lua, /settings = \{[^}]*margin = 12[^}]*\}/);
  assert.match(lua, /navVoice = false/);
  assert.match(lua, /gliderId = "HB-1"/);
});

test('IGC lesen und Wertung nachrechnen: zwei Runden, Strafe aus dem Einflug', () => {
  const task = { ...SKY.newTask('Sport'), dir: 250 };
  const igc = SKY.parseIgc(igcFlight(task, 2, { agl: 410, kmh: 100 }));
  assert.ok(igc.fixes.length > 100);
  const t = SKY.taskOfIgc(igc);
  assert.strictEqual(t.dist, 350); assert.strictEqual(t.cls, 'Sport');
  const r = SKY.evaluate(t, igc);
  assert.strictEqual(r.n, 2);
  assert.strictEqual(r.start.penalty, 50 + 2 * 10);
  assert.ok(r.laps[0].speed > 80 && r.laps[0].speed < 100, String(r.laps[0].speed));
  assert.ok(Math.abs(r.speed - 2 * r.geom.perim / r.time * 3.6) < 1e-6);
  // Index: geflogene Strecke je Runde zum Umfang; der Testflug fliegt knapp aussen um die Ecken
  for (const l of r.laps) assert.ok(l.idx > 100 && l.idx < 115, String(l.idx));
  assert.ok(Math.abs(r.idx - (r.laps[0].dist + r.laps[1].dist) / (2 * r.geom.perim) * 100) < 1e-9);
});

test('ohne Wendepunkt kein Ziel', () => {
  const task = { ...SKY.newTask('Light'), dir: 30 };
  const txt = igcFlight(task, 1).split('\r\n');
  // Fixe um TP2 entfernen: Spur schneidet die Ecke ab
  const g = SKY.geom(task), igc = SKY.parseIgc(txt.join('\r\n'));
  igc.fixes = igc.fixes.filter(f => { const [x, y] = SKY.toXY(task, g, f.lat, f.lon); return !SKY.inSector(g.tp[1], x, y); });
  assert.strictEqual(SKY.evaluate(SKY.taskOfIgc(igc), igc).n, 0);
});

test('Sync: Aufgaben auf den Sender, Flüge ins Archiv (gleich grosse überspringen)', async () => {
  const archive = tmp(), root = tmp();
  assert.deepStrictEqual((await SN.loadTasks(archive)).tasks, []);
  // ohne gespeicherte Aufgaben wird nichts auf den Sender geschrieben
  let r = await SN.syncSender(root, archive);
  assert.strictEqual(r.tasks, null);
  await assert.rejects(SN.saveTasks(archive, { tasks: [] }, 'kein lua'));
  await SN.saveTasks(archive, { version: 1, tasks: [{ id: 'a' }] }, '-- x\nreturn { tasks = {} }\n');
  assert.strictEqual((await SN.loadTasks(archive)).tasks[0].id, 'a');
  put(path.join(root, 'scripts', 'skynav', 'fluege', '2026-10-15-XSN-SKYNAV-01.IGC'), 'AXSN\r\n');
  put(path.join(root, 'scripts', 'skynav', 'fluege', '2026-10-15-XSN-SKYNAV-02.IGC'), '');   // gerade angelegt
  r = await SN.syncSender(root, archive);
  assert.strictEqual(fs.readFileSync(path.join(root, 'scripts', 'skynav', 'aufgaben.lua'), 'utf8'), '-- x\nreturn { tasks = {} }\n');
  assert.deepStrictEqual(r.flights.copied, ['2026-10-15-XSN-SKYNAV-01.IGC']);
  r = await SN.syncSender(root, archive);
  assert.deepStrictEqual([r.flights.copied.length, r.flights.same], [0, 1]);
  const fl = await SN.listFlights(archive);
  assert.deepStrictEqual(fl.map(f => f.name), ['2026-10-15-XSN-SKYNAV-01.IGC']);
  assert.ok(fl[0].path.startsWith(path.join(archive, 'SkyNavigator', 'Fluege')));
});
