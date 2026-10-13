// Macht aus dem Handbuch (docs/handbuch/handbuch.html) den Hilfetext, den die KI-Auswertung bei Fragen
// zur Bedienung liest (Werkzeug hilfe_lesen). Eine Quelle: Text nur im Handbuch ändern, dann
// `npm run hilfe` schreibt ihn zwischen die Marken in web/index.html. Der Test prüft, dass er aktuell ist.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const HANDBUCH = path.join(ROOT, 'docs', 'handbuch', 'handbuch.html');
const INDEX = path.join(ROOT, 'web', 'index.html');
const START = '// HILFE-START (erzeugt von scripts/hilfe.js aus dem Handbuch, nicht von Hand ändern)';
const ENDE = '// HILFE-ENDE';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '' };
const decode = s => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#'
  ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);
const strip = s => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// Ein Kapitel als knapper Text: Absätze, ### Unterkapitel, Listen und Tabellenzeilen als "- "
function chapterText(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<figure[\s\S]*?<\/figure>/g, '');
  const out = [];
  const push = s => { s = s.trim(); if (s) out.push(s); };
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>|<table[^>]*>([\s\S]*?)<\/table>|<(ol|ul)[^>]*>([\s\S]*?)<\/\3>|<div class="(tip|note|warn)[^"]*">([\s\S]*?)<\/div>|<p[^>]*>([\s\S]*?)<\/p>|<pre[^>]*>([\s\S]*?)<\/pre>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] != null) push('### ' + strip(m[1]));
    else if (m[2] != null) {
      for (const tr of m[2].match(/<tr[\s\S]*?<\/tr>/g) || []) {
        if (/<th/.test(tr)) continue;
        const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(strip).filter(Boolean);
        if (cells.length > 2 && /^\d+$/.test(cells[0])) cells.shift();   // Nummern zu Screenshots
        if (cells.length) push('- ' + (cells.length === 2 ? cells.join(': ') : cells.join(' | ')));
      }
    } else if (m[4] != null) {
      const items = m[4].match(/<li[^>]*>[\s\S]*?<\/li>/g) || [];
      push(items.map((li, i) => (m[3] === 'ol' ? `${i + 1}. ` : '- ') + strip(li)).join('\n'));
    } else if (m[6] != null) {
      const b = /<b>([\s\S]*?)<\/b>([\s\S]*)/.exec(m[6]);
      push(b ? `${strip(b[1])}: ${strip(b[2])}` : strip(m[6]));
    } else if (m[7] != null) push(strip(m[7]));
    else if (m[8] != null) push(decode(m[8].replace(/<[^>]+>/g, '')).trim());
  }
  return out.join('\n');
}

// Kapitel 1 bis vor "Änderungen pro Version" (das Changelog braucht die KI nicht)
function build() {
  const version = require(path.join(ROOT, 'package.json')).version;
  const html = fs.readFileSync(HANDBUCH, 'utf8').replace(/\{\{VERSION\}\}/g, version);
  const parts = html.split(/(?=<h1 id="k\d+")/).slice(1);
  const chapters = [];
  for (const p of parts) {
    const h = /^<h1 id="k(\d+)"[^>]*>(?:<span class="n">\d+<\/span>)?([\s\S]*?)<\/h1>/.exec(p);
    const titel = strip(h[2]);
    if (/^Änderungen pro Version/.test(titel)) break;
    chapters.push({ nr: +h[1], titel, text: chapterText(p.slice(h[0].length)) });
  }
  return chapters;
}

function block(chapters) {
  const json = JSON.stringify(chapters, null, 0).replace(/</g, '\\u003c').replace(/},\{/g, '},\n{');
  return `${START}\nconst HILFE=${json};\n${ENDE}`;
}

function apply(html, chapters) {
  const a = html.indexOf(START), b = html.indexOf(ENDE);
  if (a < 0 || b < a) throw new Error('Hilfe-Marken in web/index.html nicht gefunden');
  return html.slice(0, a) + block(chapters) + html.slice(b + ENDE.length);
}

module.exports = { build, apply, INDEX };

if (require.main === module) {
  const chapters = build();
  const html = fs.readFileSync(INDEX, 'utf8');
  const neu = apply(html, chapters);
  if (neu !== html) fs.writeFileSync(INDEX, neu);
  const chars = chapters.reduce((n, c) => n + c.text.length, 0);
  console.log(`Hilfe: ${chapters.length} Kapitel, ${chars} Zeichen${neu === html ? ', unverändert' : ', in web/index.html geschrieben'}`);
}
