const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/eject');

test('Laufwerk zum Sender-Ordner finden', () => {
  const vols = [{ root: '/Volumes/RADIO' }, { root: '/Volumes/RADIO2' }];
  assert.equal(E.volumeOf('/Volumes/RADIO/Radio/logs', vols, 'darwin'), '/Volumes/RADIO');
  assert.equal(E.volumeOf('/Volumes/RADIO2/logs', vols, 'darwin'), '/Volumes/RADIO2');
  assert.equal(E.volumeOf('/Volumes/X/logs', [], 'darwin'), '/Volumes/X');
  assert.equal(E.volumeOf('e:\\logs', [], 'win32'), 'E:\\');
});

test('Befehl je System', () => {
  assert.deepEqual(E.ejectCommand('/Volumes/RADIO', 'darwin'), ['diskutil', ['eject', '/Volumes/RADIO']]);
  const [cmd, args] = E.ejectCommand('E:\\', 'win32');
  assert.equal(cmd, 'powershell.exe'); assert.match(args.at(-1), /ParseName\('E:'\).*InvokeVerb\('Eject'\)/);
  assert.throws(() => E.ejectCommand("x'; rm", 'win32'));
});

test('Fehler beim Auswerfen werden gemeldet', async () => {
  const ok = (cmd, args, o, cb) => cb(null, '', '');
  await E.eject('/Volumes/RADIO', { platform: 'darwin', run: ok });
  const busy = (cmd, args, o, cb) => cb(Object.assign(new Error('x'), { code: 1 }), '', 'Volume RADIO failed to eject: in use');
  await assert.rejects(E.eject('/Volumes/RADIO', { platform: 'darwin', run: busy }), /in use/);
  await assert.rejects(E.eject('E:\\', { platform: 'win32', run: busy }), /noch verwendet/);
});

const plist = o => '<plist><dict>' + Object.entries(o).map(([k, v]) => `<key>${k}</key>` + (v === true ? '<true/>' : v === false ? '<false/>' : `<string>${v}</string>`)).join('\n') + '</dict></plist>';

test('macOS: alle Laufwerke desselben Senders finden', async () => {
  const info = {
    '/Volumes/RADIO': { ParentWholeDisk: 'disk4', MediaName: 'FrSky X20S Radio Media', BusProtocol: 'USB', Internal: false, MountPoint: '/Volumes/RADIO' },
    '/Volumes/FLASH': { ParentWholeDisk: 'disk5', MediaName: 'FrSky X20S Flash Media', BusProtocol: 'USB', Internal: false, MountPoint: '/Volumes/FLASH' },
    '/Volumes/STICK': { ParentWholeDisk: 'disk6', MediaName: 'SanDisk Ultra Media', BusProtocol: 'USB', Internal: false, MountPoint: '/Volumes/STICK' },
    '/Volumes/Macintosh HD': { ParentWholeDisk: 'disk3', MediaName: 'APPLE SSD', BusProtocol: 'Apple Fabric', Internal: true },
  };
  const run = (cmd, args, o, cb) => info[args[2]] ? cb(null, plist(info[args[2]]), '') : cb(new Error('no'), '', '');
  const vols = Object.keys(info).map(root => ({ root }));
  const r = await E.senderDisks(['/Volumes/RADIO'], vols, { run });
  assert.deepEqual(r.disks, ['disk4', 'disk5']);
  assert.deepEqual(r.mounts, ['/Volumes/RADIO', '/Volumes/FLASH']);
  // diskutil geht nicht: leer, dann wirft die App wie bisher das gefundene Laufwerk aus
  assert.deepEqual((await E.senderDisks(['/Volumes/X'], vols, { run })).disks, []);
});

test('Gerätename ohne LUN-Teil', () => {
  assert.equal(E.deviceKey('FrSky X20S Radio Media'), E.deviceKey('FrSky X20S Flash Media'));
  assert.equal(E.deviceKey('RADIO'), '');
  assert.equal(E.plistValue('<key>Internal</key><false/>', 'Internal'), false);
});
