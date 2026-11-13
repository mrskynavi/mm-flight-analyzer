// Schreibt die erwarteten Kennzahlen des Referenzsatzes nach erwartet.json.
// Aufruf: node test/referenz/erzeugen.js <Ordner mit Unterordnern SB-10, Shark …>
// Nur nach einer gewollten Änderung der Rechnung neu erzeugen und die Unterschiede im Prüfbericht begründen.
const fs = require('fs'), path = require('path');
const { kennzahlen } = require('./kennzahlen.js');
const dir = process.argv[2]; if (!dir) { console.error('Ordner fehlt'); process.exit(1); }
const out = {};
for (const m of fs.readdirSync(dir).sort()) {
  const md = path.join(dir, m); if (!fs.statSync(md).isDirectory()) continue;
  for (const f of fs.readdirSync(md).filter(f => f.endsWith('.csv')).sort()) out[f] = { modell: m, ...kennzahlen(path.join(md, f)) };
}
fs.writeFileSync(path.join(__dirname, 'erwartet.json'), JSON.stringify(out, null, 1) + '\n');
console.log(Object.keys(out).length + ' Logs geschrieben');
