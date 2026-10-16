// Eigene Widgets: von GitHub ins Benutzerverzeichnis holen und beim Anschliessen auf den Sender kopieren.
// Aufbau im Repo und im Benutzerverzeichnis wie am Sender: scripts/<name>/main.lua (+ weitere Dateien).
// Reines Node, ohne Electron, damit es sich ohne Oberfläche testen lässt.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const DEFAULT_REPO = 'mrskynavi/mm-ethos-widgets';
const DEFAULT_BRANCH = 'main';
// Dateien, die ein Widget braucht; Daten am Sender (punkte_*.txt …) kommen nie aus dem Repo
const WIDGET_EXT = /\.(lua|luac|png|bmp|jpg|wav|txt|json|cfg|ini)$/i;
// polaren.lua (Tab Polare) und skynav/aufgaben.lua (Tab SkyNavigator) schreibt die App selbst, nie aus dem Repo
const SKIP = /^scripts\/(maccready\/polaren|skynav\/aufgaben)\.lua$/i;

function defaultDir(home = require('os').homedir()) {
  return path.join(home, 'Documents', 'MM Flight Analyzer', 'Widgets');
}

// Git-Blob-SHA wie bei GitHub: so wird eine unveränderte Datei nicht nochmals geladen
const blobSha = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

const validRepo = r => /^[\w.-]+\/[\w.-]+$/.test(String(r || ''));
const validBranch = b => /^[\w./-]+$/.test(String(b || '')) && !String(b).includes('..');

// Kopfzeilen "-- @widget Name" und "-- @version 1.4" in den ersten Zeilen von main.lua
function header(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/).slice(0, 30)) {
    const m = /^\s*--\s*@(widget|version)\s+(.+?)\s*$/i.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

// Widgets im Ordner scripts/ (Benutzerverzeichnis oder Sender): [{ name, title, version, files }]
async function listWidgets(scriptsDir) {
  let ents = [];
  try { ents = await fsp.readdir(scriptsDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of ents) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const main = path.join(scriptsDir, d.name, 'main.lua');
    let text;
    try { text = await fsp.readFile(main, 'utf8'); } catch { continue; }
    const h = header(text);
    out.push({ name: d.name, title: h.widget || d.name, version: h.version || '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Dateien eines Widget-Ordners, relativ (ohne Unterordner, die mit . beginnen)
async function widgetFiles(dir, rel = '') {
  let ents = [];
  try { ents = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...await widgetFiles(dir, r));
    else if (WIDGET_EXT.test(e.name) && !/\.bak$/i.test(e.name)) out.push(r);
  }
  return out;
}

async function writeAtomic(dest, buf) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  try { await fsp.writeFile(tmp, buf); }
  catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
  await fsp.rename(tmp, dest);
}

// Vom öffentlichen GitHub-Repo holen. getJson/getBuf: (url) => Promise, damit Electron sein Netz nutzen kann.
// Liefert { widgets, loaded, same, removed }. Dateien, die im Repo gelöscht wurden, verschwinden auch lokal,
// aber nur solche, die früher von GitHub kamen (Liste in .github-files.json); eigene lokale Widgets bleiben.
async function fetchRepo({ repo, branch, dir, getJson, getBuf }) {
  if (!validRepo(repo)) throw new Error('Ungültiges GitHub-Repo (Form: besitzer/name).');
  if (!validBranch(branch)) throw new Error('Ungültiger Zweig.');
  const tree = await getJson(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const blobs = (tree.tree || []).filter(t => t.type === 'blob' && /^scripts\/[^/]+\/.+/.test(t.path) && WIDGET_EXT.test(t.path) && !SKIP.test(t.path));
  let loaded = 0, same = 0, removed = 0;
  for (const b of blobs) {
    const dest = path.join(dir, ...b.path.split('/'));
    if (!path.resolve(dest).startsWith(path.resolve(dir) + path.sep)) continue;
    try { if (blobSha(await fsp.readFile(dest)) === b.sha) { same++; continue; } } catch {}
    const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${b.path.split('/').map(encodeURIComponent).join('/')}`;
    await writeAtomic(dest, Buffer.from(await getBuf(url)));
    loaded++;
  }
  const listFile = path.join(dir, '.github-files.json');
  let before = [];
  try { before = JSON.parse(await fsp.readFile(listFile, 'utf8')).files || []; } catch {}
  const now = new Set(blobs.map(b => b.path));
  for (const p of before) {
    if (now.has(p) || !/^scripts\//.test(p) || p.includes('..')) continue;
    try { await fsp.unlink(path.join(dir, ...p.split('/'))); removed++; } catch {}
  }
  await writeAtomic(listFile, JSON.stringify({ repo, branch, at: Date.now(), files: [...now] }, null, 2));
  return { widgets: await listWidgets(path.join(dir, 'scripts')), loaded, same, removed, at: Date.now() };
}

// Alle eingeschalteten Widgets aus dem Benutzerverzeichnis auf den Sender kopieren, immer, auch bei gleicher Version.
// Alte Dateien werden ohne Sicherung überschrieben; andere Dateien im Widget-Ordner am Sender bleiben.
// senderRoot = Ordner über logs, dort liegt scripts/. off = Namen der ausgeschalteten Widgets.
async function copyToSender(dir, senderRoot, off = []) {
  const src = path.join(dir, 'scripts'), dst = path.join(senderRoot, 'scripts');
  const skip = new Set(off);
  const res = [];
  for (const w of await listWidgets(src)) {
    if (skip.has(w.name)) continue;
    const onSender = path.join(dst, w.name, 'main.lua');
    let before = null;
    try { before = header(await fsp.readFile(onSender, 'utf8')).version || ''; } catch {}
    const r = { name: w.name, title: w.title, version: w.version, before, state: before === null ? 'neu' : 'überschrieben', files: 0 };
    try {
      for (const rel of await widgetFiles(path.join(src, w.name))) {
        if (SKIP.test('scripts/' + w.name + '/' + rel)) continue;
        await writeAtomic(path.join(dst, w.name, ...rel.split('/')), await fsp.readFile(path.join(src, w.name, ...rel.split('/'))));
        r.files++;
      }
    } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) throw e;
      r.state = 'fehler'; r.error = e.message;
    }
    res.push(r);
  }
  return res;
}

module.exports = { DEFAULT_REPO, DEFAULT_BRANCH, defaultDir, blobSha, header, listWidgets, fetchRepo, copyToSender };
