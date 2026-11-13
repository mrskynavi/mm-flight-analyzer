// Rechenkern web/core/: Wind, Polare, Energie, Luftdichte, Klappen mit konstruierten Flügen, deren Ergebnis bekannt ist
const test = require('node:test');
const assert = require('node:assert');
const WI = require('../web/core/wind.js');
const PO = require('../web/core/polare.js');
const EN = require('../web/core/energie.js');
const AT = require('../web/core/atmosphaere.js');
const KL = require('../web/core/klappen.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} statt ${b} (± ${tol})`);
const D2R = Math.PI / 180;

// Kreisflug mit fester Fahrt durch die Luft in gleichmässigem Wind: Bodenvektor = Luftvektor + Windvektor
function kreisflug({ tas = 15, wind = 5, from = 270, dauer = 300, dt = 0.2, omega = 12 } = {}) {
  const t = [], spd = [], crs = [], to = (from + 180) % 360, wx = wind * Math.sin(to * D2R), wy = wind * Math.cos(to * D2R);
  for (let s = 0; s <= dauer; s += dt) {
    const h = (s * omega) % 360, gx = tas * Math.sin(h * D2R) + wx, gy = tas * Math.cos(h * D2R) + wy;
    t.push(+s.toFixed(3)); spd.push(Math.hypot(gx, gy)); crs.push((Math.atan2(gx, gy) / D2R + 360) % 360);
  }
  return { t, spd, crs };
}

test('Kasa-Kreisfit trifft einen exakten Kreis', () => {
  const x = [], y = [];
  for (let i = 0; i < 20; i++) { x.push(3 + 10 * Math.cos(i * 0.3)); y.push(-2 + 10 * Math.sin(i * 0.3)); }
  const f = WI.kasaFit(x, y, 20);
  near(f.cx, 3, 1e-9); near(f.cy, -2, 1e-9); near(f.r, 10, 1e-9);
  assert.strictEqual(WI.kasaFit([1, 2, 3], [1, 2, 3], 3), null, 'Punkte auf einer Linie');
});

test('Wind Estimator findet Wind und TAS im Kreisflug', () => {
  for (const [wind, from] of [[5, 270], [3, 45], [8, 180]]) {
    const f = kreisflug({ wind, from });
    const r = WI.windEstimator(f.t, f.spd, f.crs, 2 / 3.6);
    const i = f.t.length - 1;
    assert.ok(r.fits > 100, 'genug Fits');
    near(r.W[i], wind, 0.05, 'Windstärke'); near(((r.D[i] - from + 540) % 360) - 180, 0, 0.5, 'Windrichtung');
    near(r.TAS[i], 15, 0.05, 'TAS');
  }
});

test('Wind Estimator: Geradeausflug gibt keinen Wind (zu wenig Kursstreuung)', () => {
  const t = [], spd = [], crs = []; for (let s = 0; s < 200; s += 0.2) { t.push(s); spd.push(15); crs.push(90); }
  const r = WI.windEstimator(t, spd, crs, 2 / 3.6);
  assert.strictEqual(r.fits, 0); assert.strictEqual(r.OK[t.length - 1], 0);
  near(r.TAS[t.length - 1], 15, 1e-9, 'ohne Wind ist TAS = Grundgeschwindigkeit');
});

test('GPS-Kurs: Azimut und halbe Fixe', () => {
  near(WI.bearingDeg(47, 9, 47.001, 9), 0, 1e-6); near(WI.bearingDeg(47, 9, 47, 9.001), 90, 0.01);
  // nach Osten, Breite bleibt gleich: nur die Länge ändert sich, der Fix gilt nach 0,8 s
  const t = [], gps = []; for (let i = 0; i < 50; i++) { t.push(i * 0.5); gps.push([47, 9 + i * 0.0001]); }
  const c = WI.gpsCourse(t, gps); near(c[49], 90, 0.01);
});

test('Navigation: Steuerkurs, Drift und Gegenwind', () => {
  // Flug nach Norden über Grund mit 10 m/s, Wind 5 m/s aus Westen: Nase nach Nordwest, Drift positiv
  const { H, DR, HW } = WI.nav([10], [0], [5], [270], 0.5);
  near(H[0], 360 - Math.atan2(5, 10) / D2R, 1e-6); assert.ok(DR[0] > 0); near(HW[0], 5 * Math.cos((270 - H[0]) * D2R), 1e-9);
});

test('Polare: Fit A·v³ + B/v trifft konstruierte Klassen, Kennzahlen stimmen', () => {
  const A = 8e-5, B = 4.5, w = v => A * v ** 3 + B / v, bs = [];
  for (let k = 30; k <= 90; k += 4) bs.push({ v: k, m: w(k / 3.6), n: 20 + k });
  const f = PO.polarFit(bs);
  near(f.A, A, 1e-12); near(f.B, B, 1e-9);
  near(f.vms, Math.pow(B / (3 * A), 0.25) * 3.6, 1e-9); near(f.vbg, Math.pow(B / A, 0.25) * 3.6, 1e-9);
  near(f.ld, (f.vbg / 3.6) / w(f.vbg / 3.6), 1e-9);
  const g = PO.polarFit(bs, 'eq'); near(g.A, A, 1e-12, 'gleich gewichtet');
  const mc = PO.mcParabola(f, 30, 90); assert.ok(mc.dev < 0.05, 'Parabel weicht wenig ab'); near(mc.s(15), w(15), 0.05);
});

test('Polare: Ausreisser-Klassen, abgetrennt und mit wenig Punkten, fallen weg', () => {
  const w = v => 8e-5 * (v / 3.6) ** 3 + 4.5 / (v / 3.6), bs = [];
  for (let k = 38; k <= 78; k += 4) bs.push({ v: k, m: w(k), n: 80 });
  const ganz = [...bs, { v: 98, m: 3.5, n: 12 }, { v: 102, m: 0.9, n: 16 }];
  const r = PO.polarClean(ganz);
  assert.deepEqual(r.out.map(b => b.v), [98, 102]); assert.equal(r.bs.length, bs.length);
  // abgetrennt, aber mit vielen Punkten: bleibt (echter Schnellflug)
  assert.equal(PO.polarClean([...bs, { v: 98, m: 3.5, n: 60 }]).out.length, 0);
  // eine fehlende Klasse ist keine Lücke
  assert.equal(PO.polarClean([...bs, { v: 86, m: w(86), n: 12 }]).out.length, 0);
});

test('Polare: Abriss-Fit A·v³ + B/v + D/v⁵ trifft konstruierte Klassen und braucht langsame Punkte', () => {
  const A = 1.2e-4, B = 2, D = 4e4, w = k => { const v = k / 3.6; return A * v ** 3 + B / v + D / v ** 5; }, bs = [];
  for (let k = 30; k <= 90; k += 4) bs.push({ v: k, m: w(k), n: 40 });
  const f = PO.polarFit3(bs);
  near(f.A, A, 1e-10); near(f.B, B, 1e-5); near(f.D, D, 0.5); assert.ok(f.ok, f.why);
  // Kennzahlen: Ableitungen null
  const h = 1e-3; near(w(f.vms + h) - w(f.vms - h), 0, 1e-7, 'geringstes Sinken');
  const g = k => k / w(k); near(g(f.vbg + h) - g(f.vbg - h), 0, 1e-5, 'beste Gleitzahl');
  near(f.ld, f.vbg / 3.6 / w(f.vbg), 1e-9);
  // ohne die langsamen Klassen: Kurve kommt, gilt aber nicht
  const ohne = PO.polarFit3(bs.filter(b => b.v >= f.vms - 4));
  assert.equal(ohne.ok, false); assert.equal(ohne.why, 'langsam');
  // Netto und MacCready rechnen mit D
  near(PO.sinkAt({ A, B, D }, 12), w(12 * 3.6), 1e-12);
  const mc = PO.mcParabola(f, 46, 90); assert.ok(mc.dev < 0.08, 'Parabel ' + mc.dev);
});

test('Polare: Polarflug-Log SB-10 (06.11.2026), Ausreisser 98/102 weg, Abriss-Fit mangels langsamer Punkte nicht gültig', () => {
  const bs = require('./referenz/polarflug-sb10-klassen.json');
  const r = PO.polarClean(bs); assert.deepEqual(r.out.map(b => b.v), [98, 102]);
  const alt = PO.polarFit(bs), neu = PO.polarFit(r.bs);
  near(alt.ld, 27.9, 0.1, 'bisher'); near(neu.ld, 29.8, 0.1, 'ohne Ausreisser');
  // ohne Ausreisser liegt die Kurve im Schnellflug näher an den Klassen
  for (const k of [74, 78]) { const b = r.bs.find(x => x.v === k); assert.ok(Math.abs(b.m - neu.w(k)) < Math.abs(b.m - alt.w(k)), 'Klasse ' + k); }
  const f3 = PO.polarFit3(r.bs); assert.equal(f3.ok, false); assert.equal(f3.why, 'langsam');
  near(f3.ld, 30.5, 0.1); near(f3.vbg, 49, 0.5);
});

// Gerader Gleitflug mit Fahrt v und Sinken w, eine Zeile alle 0,25 s
function gleitflug({ v = 15, w = 0.6, dauer = 200, dt = 0.25, h0 = 300 } = {}) {
  const t = [], vv = [], alt = [], vario = [], crs = [];
  for (let s = 0; s <= dauer; s += dt) { t.push(s); vv.push(v); alt.push(h0 - w * s); vario.push(-w); crs.push(90); }
  return { t, v: vv, alt, vario, crs, motor: new Uint8Array(t.length) };
}

test('Gleitpunkte: Sinken aus der Höhe, ein Punkt je Sekunde, Motor sperrt', () => {
  const g = gleitflug();
  const pts = PO.polarPoints(g);
  assert.ok(pts.length > 160 && pts.length <= 171, `${pts.length} Punkte`);
  for (const p of pts) { near(p[0], 54, 1e-9); near(p[1], 0.6, 1e-9); }
  g.motor[400] = 1;                                    // Motor bei 100 s: ab 97,5 s (Fenster ± 2,5 s) bis 115 s keine Punkte
  const p2 = PO.polarPoints(g);
  assert.ok(!p2.some(p => g.t[p[2]] >= 97.5 && g.t[p[2]] < 115), 'keine Punkte bei Motor und 15 s danach');
});

test('Gleitpunkte: Energiekompensation, Bremsen ist kein Sinken', () => {
  // Fahrt nimmt von 16 auf 14 m/s ab, die Energie geht in Höhe: Gesamtenergie konstant, Sinken 0,5 m/s
  const t = [], v = [], alt = [], crs = [];
  for (let s = 0; s <= 120; s += 0.25) { const vi = 16 - s / 60; t.push(s); v.push(vi); crs.push(0); alt.push(200 - 0.5 * s + (16 * 16 - vi * vi) / (2 * PO.G)); }
  const pts = PO.polarPoints({ t, v, alt, crs, motor: null });
  for (const p of pts) near(p[1], 0.5, 1e-6);
});

test('Luftdichte: Normatmosphäre wie im Sollfahrt-Widget, Umrechnung auf Meereshöhe', () => {
  near(AT.sigma(0), 1, 1e-12);
  for (const h of [410, 1000, 1500, 2000]) near(AT.sigma(h), (1 - 2.2558e-5 * h) ** 4.2559, 2e-4, `h=${h}`);
  near(1 / Math.sqrt(AT.sigma(1500)), 1.076, 0.001, '1500 m: TAS +7,6 %');
  assert.ok(AT.sigma(1000, 15) < AT.sigma(1000), 'wärmer = dünner');
  // in 1500 m gemessener Punkt landet auf der Polare auf Meereshöhe
  const g = gleitflug({ v: 15, w: 0.6 }), s = AT.sigmaReihe(1200, g.alt.map(a => a), g.t.length);
  const pts = PO.polarPoints({ ...g, sigma: s }), p = pts[50], q = Math.sqrt(s[p[2]]);
  near(p[0], 54 * q, 1e-9); near(p[1], 0.6 * q, 1e-9);
  // und sinkAt rechnet in der Höhe zurück
  const ab = { A: 8e-5, B: 4.5 };
  near(PO.sinkAt(ab, 15 / Math.sqrt(0.8), 0.8), (ab.A * 15 ** 3 + ab.B / 15) / Math.sqrt(0.8), 1e-12);
  near(PO.sinkAt(ab, 15), ab.A * 15 ** 3 + ab.B / 15, 1e-12, 'ohne sigma wie bisher');
});

test('Gelände: nächstes innerhalb 5 km', () => {
  const L = [{ name: 'A', lat: 47.2006, lon: 8.9617, elev: 410 }, { name: 'B', lat: 46.5, lon: 8.0, elev: 1500 }];
  assert.strictEqual(AT.gelaende(L, 47.21, 8.96).name, 'A');
  assert.strictEqual(AT.gelaende(L, 47.6, 8.96), null);
});

test('TEK: Hochziehen ohne Energiegewinn zeigt 0, Netto zeigt die Luftmasse', () => {
  // Fahrt pendelt, Höhe tauscht Energie: Gesamtenergie sinkt mit 0,6 m/s, Luft steigt nicht
  const t = [], tas = [], alt = [], vario = [];
  for (let s = 0; s <= 200; s += 0.1) { const v = 15 + 2 * Math.sin(s / 5); t.push(s); tas.push(v); alt.push(300 - 0.6 * s - v * v / (2 * 9.81)); }
  for (let i = 0; i < t.length; i++) vario.push(i ? (alt[i] - alt[i - 1]) / 0.1 : 0);
  const ab = { A: 1e-9, B: 0.6 * 15 };                // Eigensinken ~0,6 m/s bei 15 m/s
  const r = EN.tekNetto({ t, tas, vario, alt, motor: null, ab });
  const mid = r.tek.slice(300, 1700).filter(x => !isNaN(x));
  near(mid.reduce((a, b) => a + b) / mid.length, -0.6, 0.02, 'TEK mittel');
  const n = r.net10.slice(300, 1700).filter(x => !isNaN(x)); near(n.reduce((a, b) => a + b) / n.length, 0, 0.1, 'Netto mittel');
});

test('Gleitzahl aus Strecke und Höhenverlust', () => {
  const g = gleitflug({ v: 15, w: 0.5 }), gz = EN.gleitzahl({ t: g.t, alt: g.alt, v: g.v, motor: g.motor });
  near(gz[400], 30, 1e-6);
});

// Gespiegelte Servos: Querruder geht auf beiden Kanälen gleich (roh), Wölbung entgegengesetzt
function servoLog() {
  const t = [], qr = [], K1 = [], K5 = [], K6 = [], K7 = [], K2 = [];
  for (let i = 0; i < 3000; i++) {
    const s = i * 0.2, q = 400 * Math.sin(s * 1.3) * (i % 7 ? 1 : 0.3), phase = s < 200 ? 50 : s < 400 ? -80 : 0;
    t.push(s); qr.push(q);
    K1.push(0.5 * q + phase); K5.push(0.5 * q - phase);         // Querruder mit Wölbmischung
    K6.push(0.2 * q + 2 * phase); K7.push(0.2 * q - 2 * phase);  // Wölbklappe mit Querrudermischung
    K2.push(300 * Math.cos(s));                                  // Höhenruder
  }
  return { t, qr, k: { K1, K2, K5, K6, K7 } };
}

test('Klappen: Paare erkannt, Wölbung und Stellungen', () => {
  const L = servoLog();
  const p = KL.vorschlag(L.k, L.qr);
  assert.deepStrictEqual(p.map(x => `${x.l}/${x.r}:${x.art}`), ['K1/K5:diff', 'K6/K7:diff']);
  const W = KL.woelbung(L.t, L.k, p);
  near(W[0][500], 50 * KL.PCT, 1e-9); near(W[1][1500], -160 * KL.PCT, 1e-9);
  const st = KL.stellungen(L.t.map((_, i) => i % 5 ? null : KL.vektor(W, i)));
  assert.strictEqual(st.length, 3);
  near(st[0].mitte[1], -15.6, 0.5); near(st[2].mitte[0], 4.9, 0.5);
  assert.strictEqual(KL.stellungVon(KL.vektor(W, 1500), st), 0);
  assert.ok(KL.passt([5, 10], [6, 8]) && !KL.passt([5, 10], [6, 15]));
});

test('Klappen: gleich eingebaute Servos (Wölbung = Summe)', () => {
  const L = servoLog(), k = { K1: L.k.K1, K5: L.k.K5.map((x, i) => -x) };   // K5 umgedreht
  const p = KL.vorschlag(k, L.qr);
  assert.deepStrictEqual(p.map(x => x.art), ['sum']);
  near(KL.woelbung(L.t, k, p)[0][500], 50 * KL.PCT, 1e-9);
});
