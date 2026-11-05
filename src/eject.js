// Sender sicher auswerfen, damit er abgezogen werden kann
const path = require('path');
const { execFile } = require('child_process');

// Laufwerk zu einem Ordner: das längste passende Laufwerk, sonst Laufwerksbuchstabe bzw. /Volumes/<Name>
function volumeOf(dir, vols = [], platform = process.platform) {
  const hit = vols.filter(v => dir === v.root || dir.startsWith(v.root.endsWith(path.sep) ? v.root : v.root + path.sep))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (hit) return hit.root;
  if (platform === 'win32') { const m = /^([a-z]:)/i.exec(dir); return m ? m[1].toUpperCase() + '\\' : null; }
  if (platform === 'darwin') { const m = /^(\/Volumes\/[^/]+)/.exec(dir); return m ? m[1] : null; }
  return null;
}

function ejectCommand(root, platform = process.platform) {
  if (platform === 'darwin') return ['diskutil', ['eject', root]];
  if (platform === 'win32') {
    const d = String(root).slice(0, 2).toUpperCase();
    if (!/^[A-Z]:$/.test(d)) throw new Error('Kein Laufwerksbuchstabe: ' + root);
    // Explorer-Befehl "Auswerfen"; danach prüfen, ob das Laufwerk wirklich weg ist
    const ps = `$i=(New-Object -ComObject Shell.Application).Namespace(17).ParseName('${d}'); if(-not $i){exit 2}; $i.InvokeVerb('Eject'); for($n=0;$n -lt 20;$n++){ Start-Sleep -Milliseconds 250; if(-not (Test-Path '${d}\\')){exit 0} }; exit 1`;
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]];
  }
  return ['gio', ['mount', '-e', root]];
}

// macOS: Ein Ethos-Sender meldet sich als zwei USB-Laufwerke (zwei LUNs, z.B. RADIO und FLASH).
// Wirft man nur eines aus, meldet macOS beim Abziehen "nicht ausgeworfen". Darum alle Laufwerke
// desselben Geräts suchen: externe USB-Laufwerke mit demselben Gerätenamen (MediaName ohne die LUN-Endung).
function plistValue(xml, key) {
  const m = new RegExp(`<key>${key}</key>\\s*<(string|true|false|integer)\\s*/?>([^<]*)`).exec(String(xml || ''));
  if (!m) return null;
  return m[1] === 'true' ? true : m[1] === 'false' ? false : m[2].trim();
}
function diskInfo(target, run = execFile) {
  return new Promise(res => run('diskutil', ['info', '-plist', target], { timeout: 10000 }, (err, out) => {
    if (err) return res(null);
    res({ whole: plistValue(out, 'ParentWholeDisk'), media: plistValue(out, 'MediaName') || plistValue(out, 'IORegistryEntryName') || '',
      bus: plistValue(out, 'BusProtocol') || '', internal: plistValue(out, 'Internal') === true, mount: plistValue(out, 'MountPoint') || target });
  }));
}
// "FrSky X20S Flash Media" und "FrSky X20S Radio Media" gehören zusammen: ohne "Media" und ohne letztes Wort vergleichen
const deviceKey = media => String(media || '').replace(/\s+Media$/i, '').trim().split(/\s+/).slice(0, -1).join(' ').toLowerCase();

// Liefert die ganzen Platten (disk4, disk5), die zu den gefundenen Sender-Laufwerken gehören, plus die Namen der Laufwerke
async function senderDisks(roots, vols = [], { run = execFile } = {}) {
  const own = (await Promise.all(roots.map(r => diskInfo(r, run)))).filter(i => i && i.whole);
  if (!own.length) return { disks: [], mounts: roots };
  const keys = new Set(own.map(i => deviceKey(i.media)).filter(Boolean));
  const others = (await Promise.all(vols.filter(v => !roots.includes(v.root)).map(v => diskInfo(v.root, run))))
    .filter(i => i && i.whole && !i.internal && /usb/i.test(i.bus) && keys.has(deviceKey(i.media)));
  const all = [...own, ...others];
  return { disks: [...new Set(all.map(i => i.whole))], mounts: [...new Set(all.map(i => i.mount))] };
}

function eject(root, { platform = process.platform, run = execFile } = {}) {
  const [cmd, args] = ejectCommand(root, platform);
  return new Promise((res, rej) => run(cmd, args, { windowsHide: true, timeout: 20000 }, (err, out, errOut) => {
    if (!err) return res();
    const msg = String(errOut || out || '').trim();
    rej(new Error(err.code === 1 && platform === 'win32' ? 'Das Laufwerk wird noch verwendet.' : msg || err.message));
  }));
}

module.exports = { volumeOf, ejectCommand, eject, senderDisks, deviceKey, plistValue };
