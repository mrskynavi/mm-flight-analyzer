// Baut app/ aus web/index.html: Chart.js lokal statt vom CDN, damit die App offline läuft
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'app');
fs.mkdirSync(out, { recursive: true });
let html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
const cdn = /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/[^"]+"><\/script>/;
if (!cdn.test(html)) throw new Error('Chart.js-Einbindung in web/index.html nicht gefunden');
html = html.replace(cdn, '<script src="chart.umd.min.js"></script>');
// Lua-VM für den Simulator ebenfalls lokal
const luaCdn = /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/fengari-web@[^"]+"><\/script>/;
if (!luaCdn.test(html)) throw new Error('fengari-Einbindung in web/index.html nicht gefunden');
html = html.replace(luaCdn, '<script src="fengari-web.js"></script>');
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.copyFileSync(path.join(root, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'), path.join(out, 'chart.umd.min.js'));
fs.copyFileSync(path.join(root, 'node_modules', 'fengari-web', 'dist', 'fengari-web.js'), path.join(out, 'fengari-web.js'));
for (const f of ['beispiel.csv']) {
  const src = path.join(root, 'web', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, f));
}
console.log('app/ vorbereitet');
