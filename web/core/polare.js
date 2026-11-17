// Polare aus Flugdaten: Gleitpunkte sammeln, in Fahrtklassen sortieren, Sinken = A·v³ + B/v anpassen,
// Parabel a·v² + b·v + c für die MacCready-Widgets. Reine Rechnung, läuft im Browser (window.MMFA.polare) und in Node.
(function (root) {
  'use strict';

  // half: halbes Fenster (s) je Punkt; after: s nach Motor aus; turn: höchste Kursänderung (°/s); acc: höchste Fahrtänderung (m/s²);
  // minV: kleinste Fahrt (m/s); bin: Klassenbreite (km/h); minN: Punkte je Klasse; dev: Abweichung eines Logs (Anteil); skip: s ab Logbeginn
  const POLAR = { half: 2.5, after: 15, turn: 8, acc: 0.6, minV: 5, bin: 4, minN: 12, dev: 0.2, skip: 30 };
  const G = 9.81;

  function median(a) { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
  function quant(a, p) { const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); }

  // Motor an: Drehzahl > 300 U/min, ohne Drehzahl Strom > 3 A
  function motorOn(n, rpm, cur) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = rpm ? (rpm[i] > 300 ? 1 : 0) : cur ? (cur[i] > 3 ? 1 : 0) : 0;
    return out;
  }

  // Gleitpunkte, höchstens einer je Sekunde: [Fahrt km/h, Sinken m/s (+ = sinkt), Index der Logzeile].
  // d: { t (s), v (Fahrt m/s, TAS oder GPS), alt (Höhe m) und/oder vario (m/s), motor (0/1 je Zeile), crs (Kurs °, optional),
  //      mask (true = Zeile zählt, optional), sigma (Dichteverhältnis je Zeile, optional),
  //      tasOk (1 = Fahrt ist windkorrigiert, optional: vor dem ersten Windfit ist „TAS“ nur die GPS-Geschwindigkeit) }
  // Sinken aus der Höhe, korrigiert um die Änderung der Bewegungsenergie: w = −(Δh + Δ(v²)/2g)/Δt.
  // Mit sigma wird der Punkt auf Meereshöhe umgerechnet (v·√σ, w·√σ), siehe atmosphaere.js.
  function polarPoints(d, P = POLAR) {
    const { t, v, alt, vario, motor, crs, mask, sigma, tasOk } = d;
    if (!v || !(vario || alt)) return [];
    const n = t.length, out = [];
    const lastMot = new Array(n); let lm = -Infinity;
    for (let i = 0; i < n; i++) { if (motor && motor[i]) lm = t[i]; lastMot[i] = lm; }
    let j = 0, k = 0, lastSec = -1;
    for (let i = 0; i < n; i++) {
      const ti = t[i]; if (isNaN(ti) || ti < P.skip) continue;
      const sec = Math.floor(ti); if (sec === lastSec) continue;
      while (j < i && !(t[j] >= ti - P.half)) j++;
      if (k < i) k = i; while (k < n - 1 && t[k + 1] <= ti + P.half) k++;
      const dt = t[k] - t[j]; if (!(dt >= 3) || ti - lastMot[k] < P.after) continue;
      if (mask && !(mask[j] && mask[i] && mask[k])) continue;
      if (tasOk && !tasOk[j]) continue;
      const v0 = v[j], v1 = v[k]; if (isNaN(v0) || isNaN(v1) || Math.abs(v1 - v0) / dt > P.acc) continue;
      let sv = 0, nv = 0, sw = 0, nw = 0;
      for (let m = j; m <= k; m++) { if (!isNaN(v[m])) { sv += v[m]; nv++; } if (vario && !isNaN(vario[m])) { sw += vario[m]; nw++; } }
      const vm = sv / nv; if (!(vm > P.minV)) continue;
      if (crs) { const c0 = crs[j], c1 = crs[k]; if (isNaN(c0) || isNaN(c1) || Math.abs(((c1 - c0 + 540) % 360) - 180) / dt > P.turn) continue; }
      const climb = alt ? (alt[k] - alt[j]) / dt : (nw ? sw / nw : NaN);
      const sink = -(climb + (v1 * v1 - v0 * v0) / (2 * G * dt));
      if (!(sink > -3 && sink < 5)) continue;
      const q = sigma ? Math.sqrt(sigma[i]) : 1;
      out.push([vm * q * 3.6, sink * q, i]); lastSec = sec;
    }
    return out;
  }

  // Klassen zu bin km/h; je Klasse Median, Quartile und Anzahl, nur Klassen mit mindestens minN Punkten
  function polarBins(pts, P = POLAR) {
    const b = new Map();
    for (const [v, w] of pts) { const k = Math.floor(v / P.bin) * P.bin + P.bin / 2; if (!b.has(k)) b.set(k, []); b.get(k).push(w); }
    return [...b].filter(([, a]) => a.length >= P.minN).sort((x, y) => x[0] - y[0])
      .map(([k, a]) => ({ v: k, m: median(a), q1: quant(a, .25), q3: quant(a, .75), n: a.length }));
  }

  // Kleinste Quadrate für Sinken = A·v³ + B/v (v in m/s) durch die Klassen-Mediane.
  // weight 'n' (Standard, wie bisher): jede Klasse zählt mit ihrer Punktzahl; 'eq': jede Klasse gleich.
  function polarFit(bs, weight = 'n') {
    let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0;
    for (const b of bs) { const g = weight === 'eq' ? 1 : b.n, v = b.v / 3.6, f1 = v ** 3, f2 = 1 / v; s11 += g * f1 * f1; s12 += g * f1 * f2; s22 += g * f2 * f2; t1 += g * f1 * b.m; t2 += g * f2 * b.m; }
    const det = s11 * s22 - s12 * s12; if (bs.length < 3 || !det) return null;
    const A = (t1 * s22 - t2 * s12) / det, B = (s11 * t2 - s12 * t1) / det; if (A <= 0 || B <= 0) return null;
    const w = kmh => { const v = kmh / 3.6; return A * v ** 3 + B / v; };
    const vms = Math.pow(B / (3 * A), .25) * 3.6, vbg = Math.pow(B / A, .25) * 3.6;
    return { w, A, B, vms, wms: w(vms), vbg, ld: vbg / 3.6 / w(vbg) };
  }

  // Kurve über den Klassen: 'phys' = A·v³ + B/v, 'med' = geglättete Mediane (1-2-1)
  function polarCurve(bs, mode, P = POLAR) {
    if (!bs.length || mode === 'off') return null;
    const lo = bs[0].v - P.bin / 2, hi = bs[bs.length - 1].v + P.bin / 2;
    if (mode === 'phys') {
      const f = polarFit(bs); if (!f) return null;
      const pts = []; for (let x = lo; x <= hi + .01; x += 1) pts.push({ x, y: f.w(x) }); return { pts, ...f };
    }
    const sm = bs.map((b, i) => { const a = bs[i - 1] || b, c = bs[i + 1] || b; return { x: b.v, y: (a.m + 2 * b.m + c.m) / 4 }; });
    let best = null, ld = 0, ms = sm[0];
    for (const p of sm) { const g = p.x / 3.6 / p.y; if (p.y > 0 && g > ld) { ld = g; best = p; } if (p.y < ms.y) ms = p; }
    return best ? { pts: sm, vms: ms.x, wms: ms.y, vbg: best.x, ld } : null;
  }

  // Eigensinken (m/s, + = sinkt) bei wahrer Fahrt v (m/s) in der Dichte sigma, aus der Polare {A, B} auf Meereshöhe.
  // Unter 5 m/s gilt das Sinken bei 5 m/s (die Formel steigt dort steil an).
  function sinkAt(ab, v, sigma = 1) {
    const q = Math.sqrt(sigma), ve = Math.max(v, 5) * q;   // Fahrt auf Meereshöhe
    return (ab.A * ve ** 3 + ab.B / ve) / q;
  }

  function solve3(M, r) {
    const A = M.map((row, i) => [...row, r[i]]);
    for (let i = 0; i < 3; i++) {
      let p = i; for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
      [A[i], A[p]] = [A[p], A[i]]; if (!A[i][i]) return null;
      for (let k = 0; k < 3; k++) { if (k === i) continue; const f = A[k][i] / A[i][i]; for (let j = i; j < 4; j++) A[k][j] -= f * A[i][j]; }
    }
    return A.map((row, i) => row[3] / row[i]);
  }
  // Kleinste Quadrate einer Parabel s = a·v² + b·v + c auf die Kurve A·v³ + B/v, nur im Fahrtbereich loK…hiK (km/h)
  function mcParabola(fit, loK, hiK) {
    const lo = loK / 3.6, hi = hiK / 3.6, S = [0, 0, 0, 0, 0], R = [0, 0, 0], wp = v => fit.A * v ** 3 + fit.B / v;
    for (let v = lo; v <= hi + 1e-9; v += 0.05) { const w = wp(v); let p = 1; for (let i = 0; i < 5; i++) { S[i] += p; p *= v; } R[0] += w; R[1] += w * v; R[2] += w * v * v; }
    const x = solve3([[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]], R); if (!x) return null;
    const [c, b, a] = x; if (!(a > 0) || !(c > 0)) return null;
    const s = v => a * v * v + b * v + c; let dev = 0; for (let v = lo; v <= hi + 1e-9; v += 0.05) dev = Math.max(dev, Math.abs(s(v) - wp(v)));
    const vms = -b / (2 * a), vbg = Math.sqrt(c / a);
    return { a, b, c, lo, hi, dev, s, vms, vbg, ld: vbg / s(vbg) };
  }

  const api = { POLAR, G, median, quant, motorOn, polarPoints, polarBins, polarFit, polarCurve, sinkAt, solve3, mcParabola };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.MMFA = root.MMFA || {}; root.MMFA.polare = api; }
})(typeof self !== 'undefined' ? self : this);
