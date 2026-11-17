// Energie-Rechnungen: Vario TEK (ohne Knüppelthermik), Netto-Vario (Steigen der Luft) und Gleitzahl.
// Reine Rechnung, läuft im Browser (window.MMFA.energie) und in Node. Braucht polare.js für das Eigensinken.
(function (root) {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const PO = isNode ? require('./polare.js') : root.MMFA.polare;
  const G = 9.81;

  // tek/net/core: Glättung (± s) von TEK, Netto 10 s und Netto 3 s; de: halbes Fenster der Energieänderung;
  // after: s ohne Werte nach Motor aus; maxDE: Sprünge der Fahrt über 4 m/s Energieänderung fallen weg
  const TEK = { tek: 1.5, net: 5, core: 1.5, de: 1, after: 15, maxDE: 4 };
  // half: halbes Fenster (s); minSink, minSpeed in m/s; max: grösste Gleitzahl
  const GLIDE = { half: 5, minSink: 0.2, minSpeed: 2, max: 100 };

  // Mittelwert über ±half Sekunden (Lücken und NaN zählen nicht)
  function smoothT(t, v, half) {
    const n = t.length, o = new Array(n).fill(NaN), ok = i => !isNaN(t[i]) && !isNaN(v[i]); let j = 0, k = 0, s = 0, c = 0;
    for (let i = 0; i < n; i++) {
      if (isNaN(t[i])) continue;
      while (k < n && (isNaN(t[k]) || t[k] <= t[i] + half)) { if (ok(k)) { s += v[k]; c++; } k++; }
      while (j < k && (isNaN(t[j]) || t[j] < t[i] - half)) { if (ok(j)) { s -= v[j]; c--; } j++; }
      if (c > 0) o[i] = s / c;
    }
    return o;
  }

  // Vario TEK = Vario + Änderung der Bewegungsenergie (TAS²/2g) pro Zeit.
  // Netto = Steigrate der Höhe (sonst Vario) + Energieänderung + Eigensinken aus der Polare: zeigt, wie die Luft steigt oder sinkt.
  // d: { t, tas (m/s), vario (m/s), alt (m, optional), motor (0/1 je Zeile), ab ({A, B} der Polare auf Meereshöhe, optional),
  //      sigma (Dichteverhältnis je Zeile, optional; ohne = Meereshöhe wie bisher), varioFaktor (optional, Standard 1) }
  // Ergebnis: tek (3 s gemittelt), net10, net3 (je NaN bei Motor und `after` s danach)
  function tekNetto(d, P = TEK) {
    const { t, tas, vario, alt, motor, ab, sigma, varioFaktor = 1 } = d, n = t.length;
    // varioFaktor: Eichfaktor des Vario-Sensors (1 = unverändert). Wirkt nur auf den absoluten Vario-Wert (TEK und Netto ohne Höhe),
    // nicht auf Vorzeichen oder Zeitanteile.
    const vs = smoothT(t, tas, P.tek), va = smoothT(t, vario.map(x => x * varioFaktor), 0.5);
    const E = vs.map(x => x * x / (2 * G)), off = new Uint8Array(n); let lm = -Infinity;
    // Netto aus der Höhe wie die Polare (polarPoints), damit beide zusammenpassen; TEK bleibt beim Vario
    const ar = alt ? smoothT(t, alt, 0.5) : null, ra = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) { if (motor && motor[i]) lm = t[i]; if (t[i] - lm < P.after) off[i] = 1; }
    const raw = new Array(n).fill(NaN); let j = 0, k = 0;
    for (let i = 0; i < n; i++) {
      if (isNaN(t[i]) || off[i]) continue;
      while (j < i && !(t[j] >= t[i] - P.de)) j++; if (k < i) k = i; while (k < n - 1 && t[k + 1] <= t[i] + P.de) k++;
      const dt = t[k] - t[j], de = (E[k] - E[j]) / dt; if (!(dt > 0.5) || isNaN(de) || Math.abs(de) > P.maxDE || isNaN(va[i])) continue;
      raw[i] = va[i] + de; if (ar) ra[i] = (ar[k] - ar[j]) / dt + de;
    }
    const mask = a => a.map((x, i) => off[i] ? NaN : x), tek = mask(smoothT(t, raw, P.tek));
    if (!ab) return { tek, net10: null, net3: null, vs };
    const nr = (ar ? ra : raw).map((x, i) => isNaN(x) || isNaN(vs[i]) ? NaN : x + PO.sinkAt(ab, vs[i], sigma ? sigma[i] : 1));
    return { tek, net10: mask(smoothT(t, nr, P.net)), net3: mask(smoothT(t, nr, P.core)), vs };
  }

  // Gleitzahl = waagrecht geflogene Strecke durch Höhenverlust über ±half s. Strecke aus v (m/s, TAS oder GPS).
  // Nur im Gleitflug: Motor aus im ganzen Fenster, mindestens minSink Sinken und minSpeed Fahrt.
  function gleitzahl(d, P = GLIDE) {
    const { t, alt: a, v, motor } = d, n = t.length, out = new Array(n).fill(NaN);
    const S = new Array(n).fill(0), M = new Array(n).fill(0);            // aufsummierte Strecke (m) und Motor-Zeilen
    for (let i = 1; i < n; i++) {
      const dt = t[i] - t[i - 1], sp = (v[i] + v[i - 1]) / 2;
      S[i] = S[i - 1] + (isNaN(dt) || isNaN(sp) || dt <= 0 || dt > 5 ? 0 : sp * dt); M[i] = M[i - 1] + (motor && motor[i] ? 1 : 0);
    }
    let j = 0, k = 0;
    for (let i = 0; i < n; i++) {
      if (isNaN(t[i])) continue;
      while (j < i && !(t[j] >= t[i] - P.half)) j++;
      if (k < i) k = i; while (k < n - 1 && t[k + 1] <= t[i] + P.half) k++;
      const dt = t[k] - t[j], loss = a[j] - a[k];
      if (!(dt >= P.half) || isNaN(loss) || M[k] - M[j] + (motor && motor[j] ? 1 : 0) > 0) continue;
      const dist = S[k] - S[j];
      if (loss / dt < P.minSink || dist / dt < P.minSpeed) continue;
      const gz = dist / loss; if (gz <= P.max) out[i] = gz;
    }
    return out;
  }

  // Vario-Eichfaktor lernen: Vario und Höhenänderung messen dieselbe Bewegung, darum ist der Motor für die Eichung egal.
  // Je Fenster W s: Höhenänderung Δh geteilt durch Zeit (Rate) gegen das mittlere Vario. Gesucht ist f mit f·Vario ≈ Rate
  // (Kleinste Quadrate durch den Nullpunkt). Nur Fenster mit merklichem Steigen oder Sinken (|Vario| ≥ minAbs) zählen.
  // Ergebnis: { faktor, n, ok }; ok = genug Fenster und plausibel (0,6 … 1,6).
  // d: { t, vario (m/s), alt (m) }
  function varioLernen(d, { W = 10, minN = 60, minAbs = 0.4 } = {}) {
    const { t, vario, alt } = d, n = t.length;
    let num = 0, den = 0, cnt = 0, j = 0;
    for (let i = 0; i < n; i++) {
      if (isNaN(t[i]) || isNaN(alt[i])) continue;
      while (j < i && t[j] < t[i] - W) j++;
      const dt = t[i] - t[j]; if (dt < 0.9 * W || isNaN(alt[j])) continue;
      let sv = 0, c = 0; for (let m = j; m <= i; m++) if (!isNaN(vario[m])) { sv += vario[m]; c++; }
      if (c < 5) continue;
      const vm = sv / c; if (Math.abs(vm) < minAbs) continue;
      num += ((alt[i] - alt[j]) / dt) * vm; den += vm * vm; cnt++;
    }
    if (!(den > 0) || cnt < minN) return { faktor: null, n: cnt, ok: false };
    const f = num / den;
    return { faktor: +f.toFixed(3), n: cnt, ok: f >= 0.6 && f <= 1.6 };
  }

  const api = { TEK, GLIDE, smoothT, tekNetto, gleitzahl, varioLernen };
  if (isNode) module.exports = api;
  else { root.MMFA = root.MMFA || {}; root.MMFA.energie = api; }
})(typeof self !== 'undefined' ? self : this);
