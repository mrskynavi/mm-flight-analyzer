// Luftdichte nach Normatmosphäre (ISA, Troposphäre bis 11 km) und Umrechnung der Polare auf Meereshöhe.
// Fahrt und Sinken eines Modells hängen über die Dichte zusammen: bei gleichem Anstellwinkel (gleiches Ca) gilt
// v ~ 1/√ρ und Sinken ~ 1/√ρ. Darum wird jede gemessene Polare auf ISA-Meereshöhe (ρ0 = 1,225 kg/m³) umgerechnet:
//   v0 = v · √σ,  w0 = w · √σ   mit σ = ρ/ρ0
// und für eine Rechnung in der Höhe zurück: w(v) = w0(v · √σ) / √σ.
// Die Polare bleibt dabei dieselbe Kurve in „äquivalenter Fahrt“ (EAS); Re-Zahl-Effekte (etwa 1 % Cw je 10 % Re) sind vernachlässigt.
(function (root) {
  'use strict';

  const ISA = { T0: 288.15, P0: 101325, RHO0: 1.225, L: 0.0065, R: 287.053, G: 9.80665 };
  const EXP = ISA.G / (ISA.R * ISA.L);           // 5,2559
  const RHO0 = ISA.P0 / (ISA.R * ISA.T0);        // 1,2250 kg/m³, genau passend zu R, damit σ(0) = 1

  // h in m über Meer; dT = Abweichung der Temperatur von der Normatmosphäre in K (0 = Norm)
  function luft(h, dT = 0) {
    h = Math.max(-500, Math.min(11000, h || 0));
    const Tisa = ISA.T0 - ISA.L * h, p = ISA.P0 * Math.pow(Tisa / ISA.T0, EXP), T = Tisa + (dT || 0);
    const rho = p / (ISA.R * T);
    return { h, T, p, rho, sigma: rho / RHO0 };
  }
  // Dichteverhältnis σ = ρ/ρ0; ohne Temperatur identisch mit (1 − 2,2558e-5·h)^4,2559 wie im Sollfahrt-Widget
  const sigma = (h, dT = 0) => luft(h, dT).sigma;

  // σ je Logzeile: Platzhöhe (m ü. M.) plus Höhe über dem Start aus dem Log (m); fehlt die Höhe, gilt die Platzhöhe
  function sigmaReihe(platz, alt, n, dT = 0) {
    const out = new Array(n), s0 = sigma(platz, dT);
    for (let i = 0; i < n; i++) { const a = alt ? alt[i] : NaN; out[i] = isNaN(a) ? s0 : sigma(platz + a, dT); }
    return out;
  }

  // Gelände: Liste {name, lat, lon, elev}; das nächste innerhalb maxKm gilt, sonst null
  function gelaende(liste, lat, lon, maxKm = 5) {
    if (!Array.isArray(liste) || !(Math.abs(lat) > 0.01)) return null;
    let best = null, bd = Infinity;
    for (const g of liste) {
      if (!(isFinite(g.lat) && isFinite(g.lon) && isFinite(g.elev))) continue;
      const dLat = (g.lat - lat) * Math.PI / 180, dLon = (g.lon - lon) * Math.PI / 180 * Math.cos((lat + g.lat) / 2 * Math.PI / 180);
      const d = Math.sqrt(dLat * dLat + dLon * dLon) * 6371;
      if (d < bd) { bd = d; best = g; }
    }
    return best && bd <= maxKm ? { ...best, km: bd } : null;
  }

  const api = { ISA, luft, sigma, sigmaReihe, gelaende };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.MMFA = root.MMFA || {}; root.MMFA.atmosphaere = api; }
})(typeof self !== 'undefined' ? self : this);
