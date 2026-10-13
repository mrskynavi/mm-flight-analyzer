// Log-Sync: findet den angeschlossenen Ethos- oder Jeti-Sender, kopiert neue Logs ins Archiv (ein Ordner pro Modell).
// Reines Node, ohne Electron, damit es sich ohne Oberfläche testen lässt.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const NAME_RE = /^(.*?)-(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})\.(csv|log)$/i;
// Jeti: Log/JJJJMMTT/hh-mm-ss.log; im Archiv heisst er Jeti-JJJJ-MM-TT-hh-mm-ss.log (Ordner "Jeti", das Modell erkennt die App am Inhalt)
const JETI_DIR_RE = /^(\d{4})(\d{2})(\d{2})$/;
const JETI_FILE_RE = /^(\d{2})-(\d{2})-(\d{2})\.log$/i;
const isLogName = name => !name.startsWith('._') && (/\.csv$/i.test(name) || /^Jeti-.*\.log$/i.test(name));

// UTF-8, sonst Latin-1 (Jeti schreibt °, ä … in Latin-1). Am Rand eines Ausschnitts darf ein Zeichen abgeschnitten sein.
function decodeText(buf) {
  const s = buf.toString('utf8');
  return /\uFFFD/.test(s.slice(2, -2)) ? buf.toString('latin1') : s;
}

function modelOf(name) {
  const m = NAME_RE.exec(name);
  return m ? m[1] : 'Ohne Modell';
}

// Modellname als Ordnername, auf Windows und macOS gültig
function safeDir(s) {
  return String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim() || 'Ohne Modell';
}

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

// macOS fragt beim ersten Zugriff auf ein Wechselmedium nach der Erlaubnis. Solange die Frage
// offen ist, schlägt jeder Zugriff fehl und würde eine weitere Frage auslösen. Deshalb wird ein
// Laufwerk nach "keine Berechtigung" eine Weile in Ruhe gelassen, und ein laufender Sync bricht
// beim ersten verweigerten Zugriff ab, statt jede Datei einzeln zu versuchen.
const DENY_PAUSE = 30000;
const denied = new Map();
const isDenied = e => e && (e.code === 'EPERM' || e.code === 'EACCES');
// Prüft mit readdir, weil erst das Lesen des Inhalts die Frage auslöst (stat geht auch ohne Erlaubnis)
async function probeDir(p, root, force) {
  if (!force && (denied.get(root) || 0) > Date.now()) return false;
  try { await fsp.readdir(p); return true; }
  catch (e) { if (isDenied(e)) denied.set(root, Date.now() + DENY_PAUSE); return false; }
}

// Windows: Laufwerksbezeichnung über "vol", kurz gecacht
const labelCache = new Map();
function winLabel(letter) {
  const hit = labelCache.get(letter);
  if (hit && Date.now() - hit.t < 30000) return Promise.resolve(hit.label);
  return new Promise(res => {
    execFile('cmd.exe', ['/c', 'vol', letter + ':'], { windowsHide: true, timeout: 3000 }, (err, out) => {
      const m = /(?:is|ist)\s+(.+?)\s*$/im.exec(String(out || '').split(/\r?\n/)[0] || '');
      const label = err || !m ? '' : m[1].trim();
      labelCache.set(letter, { t: Date.now(), label });
      res(label);
    });
  });
}

// Alle eingehängten Laufwerke mit Namen: { root, label }
async function volumes(platform = process.platform) {
  if (platform === 'win32') {
    const out = [];
    for (const L of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = L + ':\\';
      if (await isDir(root)) out.push({ root, label: await winLabel(L) });
    }
    return out;
  }
  const bases = platform === 'darwin' ? ['/Volumes'] :
    [`/media/${os.userInfo().username}`, `/run/media/${os.userInfo().username}`, '/media', '/mnt'];
  const out = [];
  for (const b of bases) {
    let names = [];
    try { names = await fsp.readdir(b, { withFileTypes: true }); } catch { continue; }
    for (const d of names) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      out.push({ root: path.join(b, d.name), label: d.name });
    }
  }
  return out;
}

// Wo liegen die Logs? senderPath ist relativ ("Radio/logs") oder absolut ("E:\\logs").
// Relativ wird auf jedem Laufwerk gesucht; ist der erste Teil der Name des Laufwerks
// (Laufwerk "RADIO" mit Ordner "logs"), zählt das auch.
async function findSenderDirs(senderPath, vols, force = false) {
  const p = String(senderPath || '').trim();
  if (!p) return [];
  if (path.isAbsolute(p) || /^[a-z]:[\\/]/i.test(p)) return (await probeDir(p, p, force)) ? [p] : [];
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const found = [];
  for (const v of vols) {
    const cands = [path.join(v.root, ...parts)];
    if (parts.length > 1 && v.label && v.label.toLowerCase() === parts[0].toLowerCase())
      cands.push(path.join(v.root, ...parts.slice(1)));
    for (const c of cands) if (!found.includes(c) && await probeDir(c, v.root, force)) found.push(c);
  }
  return found;
}

// strict: "keine Berechtigung" wird weitergereicht statt die Datei still zu überspringen
async function listCsv(dir, strict = false) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch (e) { if (strict && isDenied(e)) throw e; return []; }
  const out = [];
  for (const name of names) {
    if (!isLogName(name)) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs });
    } catch (e) { if (strict && isDenied(e)) throw e; }
  }
  return out;
}

// Jeti-Logs aus Log/JJJJMMTT/hh-mm-ss.log, mit dem Namen fürs Archiv
async function listJeti(dir, strict = false) {
  let days = [];
  try { days = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { if (strict && isDenied(e)) throw e; return []; }
  const out = [];
  for (const d of days) {
    const dm = JETI_DIR_RE.exec(d.name);
    if (!dm || !d.isDirectory()) continue;
    let names = [];
    try { names = await fsp.readdir(path.join(dir, d.name)); } catch (e) { if (strict && isDenied(e)) throw e; continue; }
    for (const n of names) {
      const fm = JETI_FILE_RE.exec(n);
      if (!fm) continue;
      const src = path.join(dir, d.name, n);
      try {
        const st = await fsp.stat(src);
        if (st.isFile()) out.push({ name: `Jeti-${dm[1]}-${dm[2]}-${dm[3]}-${fm[1]}-${fm[2]}-${fm[3]}.log`, size: st.size, mtime: st.mtimeMs, src });
      } catch (e) { if (strict && isDenied(e)) throw e; }
    }
  }
  return out;
}

// Ein Log gilt als vorhanden, wenn es im Modell-Ordner mit gleicher Grösse liegt
async function plan(src, archive, jeti = false) {
  const files = jeti ? await listJeti(src, true) : await listCsv(src, true), todo = [];
  let skipped = 0;
  for (const f of files) {
    const dest = path.join(archive, safeDir(modelOf(f.name)), f.name);
    let same = false;
    try { same = (await fsp.stat(dest)).size === f.size; } catch {}
    if (same) skipped++; else todo.push({ ...f, src: f.src || path.join(src, f.name), dest });
  }
  return { files, todo, skipped };
}

// Jeti-Sender: Ordner "Log" im Wurzelverzeichnis eines Laufwerks mit Tagesordnern JJJJMMTT
async function findJetiDirs(vols, force = false) {
  const found = [];
  for (const v of vols) {
    const d = path.join(v.root, 'Log');
    if (!(await isDir(d)) || !(await probeDir(d, v.root, force))) continue;
    let ents = [];
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    if (ents.some(e => e.isDirectory() && JETI_DIR_RE.test(e.name))) found.push(d);
  }
  return found;
}

async function copyOne(f) {
  await fsp.mkdir(path.dirname(f.dest), { recursive: true });
  const tmp = f.dest + '.part';
  try { await fsp.copyFile(f.src, tmp); }
  catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
  await fsp.rename(tmp, f.dest);
  const t = new Date(f.mtime);
  try { await fsp.utimes(f.dest, t, t); } catch {}
}

async function syncDir(src, archive, onProgress = () => {}, jeti = false) {
  const { files, todo, skipped } = await plan(src, archive, jeti);
  const bytes = todo.reduce((a, f) => a + f.size, 0);
  const res = { source: src, total: files.length, skipped, copied: [], errors: [], bytes };
  let doneBytes = 0;
  onProgress({ state: 'copy', source: src, total: todo.length, done: 0, skipped, bytes, doneBytes });
  for (const f of todo) {
    onProgress({ state: 'copy', source: src, total: todo.length, done: res.copied.length + res.errors.length, skipped, bytes, doneBytes, file: f.name });
    try { await copyOne(f); res.copied.push({ name: f.name, model: modelOf(f.name), path: f.dest }); }
    catch (e) {
      if (isDenied(e)) throw e;
      // Sender während dem Sync abgezogen: kein Fehler pro Datei, sondern abbrechen
      if (!(await isDir(src))) { res.interrupted = true; res.left = todo.length - res.copied.length - res.errors.length; break; }
      res.errors.push({ name: f.name, error: e.message });
    }
    doneBytes += f.size;
  }
  return res;
}

// Ein Log ins Archiv legen (manuell eingelesen). Liegt es schon dort, passiert nichts.
async function archiveFile(archive, name, data) {
  const dest = path.join(archive, safeDir(modelOf(name)), path.basename(name));
  try { if ((await fsp.stat(dest)).size === data.length) return { path: dest, existed: true }; } catch {}
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest + '.part', data);
  await fsp.rename(dest + '.part', dest);
  return { path: dest, existed: false };
}

// Polaren fürs MacCready-Widget auf den Sender: scripts/maccready/polaren.lua neben dem Widget
const POLAR_FILE = ['scripts', 'maccready', 'polaren.lua'];
async function writePolars(root, text) {
  const s = String(text || '');
  if (!s.startsWith('--') || s.length > 200000) throw new Error('Ungültiger Inhalt');
  const dest = path.join(root, ...POLAR_FILE);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, s, 'utf8');
  return dest;
}

// Simulator: Textdateien aus einem scripts-Ordner (Widgets, polaren.lua …), Pfade relativ zum Ordner
const SCRIPT_EXT = /\.(lua|txt|json|csv|cfg|ini)$/i;
async function readScripts(dir, max = 600) {
  const files = {};
  let n = 0;
  const walk = async (d, rel, depth) => {
    let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (n >= max || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (depth < 4) await walk(p, r, depth + 1); continue; }
      if (!SCRIPT_EXT.test(e.name)) continue;
      const st = await fsp.stat(p).catch(() => null);
      if (!st || st.size > 2e6) continue;
      files[r] = decodeText(await fsp.readFile(p)); n++;
    }
  };
  await walk(dir, '', 0);
  return files;
}
// Widget-Datei zurückschreiben; nur .lua innerhalb des Ordners, die alte Datei bleibt als .bak
async function writeScript(dir, rel, text) {
  const s = String(text ?? '');
  if (!/\.lua$/i.test(rel) || s.length > 2e6) throw new Error('Ungültige Datei');
  const base = path.resolve(dir) + path.sep, dest = path.resolve(dir, rel);
  if (!dest.startsWith(base)) throw new Error('Pfad ausserhalb des scripts-Ordners');
  if (fs.existsSync(dest)) await fsp.copyFile(dest, dest + '.bak');
  await fsp.writeFile(dest, s, 'utf8');
  return dest;
}

// Alle Logs im Archiv (Modell-Ordner und lose CSVs in der Wurzel)
async function listArchive(archive) {
  const out = [];
  const add = async dir => { for (const f of await listCsv(dir)) out.push({ ...f, path: path.join(dir, f.name) }); };
  if (!(await isDir(archive))) return out;
  // Modell-Ordner direkt im Archiv; ältere Ablagen mit tieferen Ordnern werden bis 3 Ebenen mitgenommen
  const walk = async (dir, depth) => {
    await add(dir);
    if (depth >= 3) return;
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) if (d.isDirectory() && !d.name.startsWith('.')) await walk(path.join(dir, d.name), depth + 1);
  };
  await walk(archive, 0);
  return out;
}

// Cloud-Ordner vorschlagen: Google Drive, dann OneDrive, sonst Dokumente
function defaultArchive(env = process.env, home = os.homedir(), platform = process.platform) {
  const tries = [];
  if (platform === 'win32') {
    for (const L of 'GHIJKLM') tries.push(`${L}:\\My Drive`, `${L}:\\Meine Ablage`);
    tries.push(path.join(home, 'Google Drive', 'My Drive'), path.join(home, 'Google Drive'));
    if (env.OneDrive) tries.push(env.OneDrive);
    if (env.OneDriveConsumer) tries.push(env.OneDriveConsumer);
  } else if (platform === 'darwin') {
    const cs = path.join(home, 'Library', 'CloudStorage');
    let names = [];
    try { names = fs.readdirSync(cs); } catch {}
    for (const n of names.filter(n => n.startsWith('GoogleDrive-'))) tries.push(path.join(cs, n, 'My Drive'), path.join(cs, n, 'Meine Ablage'));
    tries.push(path.join(home, 'Google Drive', 'My Drive'));
    for (const n of names.filter(n => n.startsWith('OneDrive'))) tries.push(path.join(cs, n));
  }
  for (const t of tries) { try { if (fs.statSync(t).isDirectory()) return path.join(t, 'Ethos Logs'); } catch {} }
  return path.join(home, 'Documents', 'Ethos Logs');
}

function rootOf(d, vols) {
  const v = vols.filter(v => d.startsWith(v.root)).sort((a, b) => b.root.length - a.root.length)[0];
  return v ? v.root : d;
}

// Schaut alle paar Sekunden nach dem Sender und synchronisiert einmal pro Anschluss
class SyncWatcher extends EventEmitter {
  constructor(getSettings, opts = {}) {
    super();
    this.getSettings = getSettings;
    this.interval = opts.interval || 3000;
    this.volumes = opts.volumes || volumes;
    this.synced = new Set();
    this.busy = false;
    this.status = { state: 'idle' };
    this.roots = [];        // Laufwerke der zuletzt gefundenen Sender
    this.ethosRoots = [];   // Ethos: Ordner über logs, dorthin geht scripts/maccready/polaren.lua
    this.paused = false;    // während dem Auswerfen nicht auf den Sender zugreifen
    this.afterEthos = opts.afterEthos || null;   // nach dem Log-Sync: eigene Widgets auf den Sender (Ordner über logs)
  }
  start() { this.stop(); this.timer = setInterval(() => this.poll(), this.interval); this.poll(); }
  stop() { clearInterval(this.timer); this.timer = null; }
  set(s) { this.status = s; this.emit('status', s); }
  async poll(force = false) {
    if (this.busy || this.paused) return this.status;
    const st = this.getSettings();
    if (!force && !st.autoSync) { if (this.status.state !== 'off') this.set({ state: 'off' }); return this.status; }
    this.busy = true;
    try {
      const vols = await this.volumes();
      const ethos = await findSenderDirs(st.senderPath, vols, force);
      const jeti = st.jetiSync === false ? [] : (await findJetiDirs(vols, force)).filter(d => !ethos.includes(d));
      const dirs = [...ethos, ...jeti];
      this.roots = [...new Set(dirs.map(d => rootOf(d, vols)))];
      this.ethosRoots = [...new Set(ethos.map(d => path.dirname(d)))];   // Ordner über logs, dort liegt auch scripts
      for (const d of [...this.synced]) if (!dirs.includes(d)) this.synced.delete(d);
      if (!dirs.length) {
        // Sender abgezogen: das letzte Ergebnis bleibt sichtbar
        if (this.status.state === 'denied' && [...denied.values()].some(t => t > Date.now())) return this.status;
        if (this.status.state === 'done' && this.status.connected) this.set({ ...this.status, connected: false });
        else if (this.status.state !== 'done' && this.status.state !== 'idle') this.set({ state: 'idle' });
        return this.status;
      }
      const todo = force ? dirs : dirs.filter(d => !this.synced.has(d));
      if (!todo.length) return this.status;
      const all = { state: 'done', connected: true, archive: st.archiveDir, sources: [], copied: [], errors: [], skipped: 0, total: 0, interrupted: false, left: 0, at: Date.now() };
      for (const d of todo) {
        this.set({ state: 'copy', source: d, total: 0, done: 0 });
        let r;
        try { r = await syncDir(d, st.archiveDir, p => this.set(p), jeti.includes(d)); }
        catch (e) {
          if (!isDenied(e)) throw e;
          // Zugriff verweigert (macOS fragt gerade nach): Laufwerk in Ruhe lassen, später nochmals
          denied.set(rootOf(d, vols), Date.now() + DENY_PAUSE);
          this.set({ state: 'denied', source: d });
          return this.status;
        }
        if (r.interrupted) { all.interrupted = true; all.left += r.left; all.connected = false; }
        else this.synced.add(d);
        all.sources.push(d); all.copied.push(...r.copied); all.errors.push(...r.errors);
        all.skipped += r.skipped; all.total += r.total;
      }
      const fresh = [...new Set(todo.filter(d => ethos.includes(d) && this.synced.has(d)).map(d => path.dirname(d)))];
      if (this.afterEthos && fresh.length) {
        this.set({ state: 'widgets', source: fresh[0] });
        try { all.widgets = await this.afterEthos(fresh); }
        catch (e) { all.widgets = { error: isDenied(e) ? 'Keine Berechtigung zum Schreiben auf den Sender.' : e.message }; }
      }
      this.set(all);
      return all;
    } catch (e) {
      this.set({ state: 'error', error: e.message });
      return this.status;
    } finally { this.busy = false; }
  }
}

module.exports = { denied, modelOf, safeDir, decodeText, volumes, findSenderDirs, findJetiDirs, listCsv, listJeti, syncDir, archiveFile, writePolars, readScripts, writeScript, listArchive, defaultArchive, SyncWatcher };
