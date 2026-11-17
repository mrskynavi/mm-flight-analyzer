// Ethos-CSV für Tests lesen und so auswerten wie der Flight Analyzer (web/index.html: addWind, addTek, polarPoints).
// Bewusst klein: Zeit, GPS, Zahlenspalten nach Namen; Geschwindigkeit in m/s.
const fs = require('fs');
const WIND = require('../../web/core/wind.js');
const PO = require('../../web/core/polare.js');
const EN = require('../../web/core/energie.js');
const AT = require('../../web/core/atmosphaere.js');
const KL = require('../../web/core/klappen.js');

const parseTime = s => { const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(s.trim()); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };
const SPEED = { 'km/h': 1 / 3.6, kn: 0.514444, 'm/s': 1, mph: 0.44704 };

function lesen(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const d = lines[0].split(';').length > lines[0].split(',').length ? ';' : ',';
  const head = lines[0].split(d).map(h => h.trim());
  const rows = lines.slice(1).map(l => l.split(d));
  const ti = head.indexOf('Time'), gi = head.indexOf('GPS');
  let t0 = null, prev = null, acc = 0;
  const t = rows.map(r => {
    const s = parseTime(r[ti] || ''); if (s == null) return NaN;
    if (t0 == null) { t0 = prev = s; return 0; }
    let dd = s - prev; prev = s; if (dd < -600) dd += 86400; if (dd < 0) dd = 0; acc += dd; return acc;
  });
  const cols = {}, units = {};
  head.forEach((h, i) => {
    if (i === ti || i === gi || !h || /^(Date|GPS-Zeit)/.test(h)) return;
    const m = /^(.*?)\(([^)]*)\)$/.exec(h), name = (m ? m[1] : h).trim(), unit = m ? m[2].trim() : '';
    if (name in cols) return;
    cols[name] = rows.map(r => { const v = parseFloat(r[i]); return isNaN(v) ? NaN : v; }); units[name] = unit;
  });
  const gps = gi < 0 ? null : rows.map(r => { const p = (r[gi] || '').trim().split(/\s+/).map(Number); return p.length === 2 && !p.some(isNaN) && Math.abs(p[0]) > 0.01 ? p : null; });
  return { file, t, cols, units, gps };
}

const finde = (log, re) => Object.keys(log.cols).find(k => re.test(k));
// Kanäle wie channels() im Flight Analyzer
function kanaele(log) {
  const c = n => n ? log.cols[n] : null;
  const alt = finde(log, /^(Altitude|Alt|Höhe|Flughöhe)$/i) || finde(log, /^(GAlt|GPS Alt)/i);
  const spd = finde(log, /(GPS-?Geschw|GSpd|GPS Speed|Speed)/i);
  return {
    alt: c(alt), altName: alt, vario: c(finde(log, /(Vario|VSpd|Steig)/i)),
    spd: spd ? log.cols[spd].map(v => v * (SPEED[log.units[spd]] || 1)) : null,
    rpm: c(finde(log, /(U\/min|RPM|Drehzahl)/i)), cur: c(finde(log, /^(ESC Strom|Current|Curr|ESC ?A)/i)),
  };
}

// Auswertung wie im Flight Analyzer; opts: { platz (m ü. M., null = ohne Dichtekorrektur), ab (Polare für Netto), maske }
function auswerten(log, opts = {}) {
  const ch = kanaele(log), n = log.t.length, t = log.t;
  const crs = WIND.gpsCourse(t, log.gps);
  const motor = PO.motorOn(n, ch.rpm, ch.cur);
  const r = ch.spd ? WIND.windEstimator(t, ch.spd, crs, WIND.WIND.minSpeed / 3.6) : null;
  const tas = r ? r.TAS : ch.spd;
  const sigma = opts.platz != null ? AT.sigmaReihe(opts.platz, ch.alt, n) : null;
  const pts = PO.polarPoints({ t, v: tas, alt: ch.alt, vario: ch.vario, motor, crs, mask: opts.maske, sigma, tasOk: r && r.fits ? r.OK : null });
  const tn = r && ch.vario ? EN.tekNetto({ t, tas, vario: ch.vario, alt: ch.alt, motor, ab: opts.ab, sigma }) : null;
  return { ch, crs, motor, wind: r, tas, sigma, pts, tn };
}

// Servokanäle K1…K64 und Querruderknüppel
function servos(log) {
  const k = {}; for (const n of Object.keys(log.cols)) if (/^K\d+$/.test(n)) k[n] = log.cols[n];
  return { kanaele: k, qr: log.cols.QR || null };
}

module.exports = { lesen, kanaele, auswerten, servos, WIND, PO, EN, AT, KL };
