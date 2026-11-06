(() => {
  const P = window.__MOCK || {};
  if (!P.desktop) return;
  const syncCbs = []; let updCb = null;
  const csv = () => window.__CSV;
  const base = '/Users/christoph/Library/CloudStorage/OneDrive-Persönlich/Ethos Logs';
  const logs = [
    ['SB-10','2026-10-02-14-39-06',2780000],['SB-10','2026-09-28-16-05-12',2410000],['SB-10','2026-09-21-11-22-40',1980000],
    ['SB-10','2026-09-14-15-48-03',2650000],['SB-10','2026-08-30-10-12-55',1520000],
    ['PlusX','2026-10-01-17-20-31',1830000],['PlusX','2026-09-20-14-02-10',2210000],['Ventus','2026-09-07-12-44-18',2950000],
  ].map(([m,d,s])=>({ name:`${m}-${d}.csv`, path:`${base}/${m}/${m}-${d}.csv`, size:s, model:m }));
  window.__STATUS = P.status || { state:'done', connected:true, archive:base, sources:['/Volumes/RADIO/logs'], copied:[{name:'SB-10-2026-10-02-14-39-06.csv',model:'SB-10'},{name:'PlusX-2026-10-01-17-20-31.csv',model:'PlusX'}], errors:[], skipped:61, total:2, interrupted:false, left:0, at: Date.parse('2026-10-05T12:31:00+02:00') };
  window.ethosDesktop = {
    getSettings: async () => ({ senderPath:'Radio/logs', archiveDir:base, autoSync:true, archiveManual:false }),
    setSettings: async s => s,
    pickFolder: async () => null,
    syncNow: async () => window.__STATUS,
    ejectSender: async () => {},
    syncStatus: async () => window.__STATUS,
    onSync: cb => { syncCbs.push(cb); },
    listArchive: async () => logs,
    saveToArchive: async () => ({ existed:false }),
    openArchive: async () => '',
    readFile: async () => { while(!csv()) await new Promise(r=>setTimeout(r,50)); return csv(); },
    peekFile: async (p, n) => { while(!csv()) await new Promise(r=>setTimeout(r,50)); const t=csv(); const L=logs.find(l=>l.path===p); const u=t.slice(0, Math.round(t.length*Math.min(1,(L?L.size:t.length)/2780000))); return { head:t.slice(0,n), tail:u.slice(-n), size:L?L.size:t.length }; },
    checkUpdate: async () => P.update || { current:P.version, latest:P.version, newer:false },
    appVersion: async () => P.version,
    onUpdate: cb => { updCb = cb; },
    openUpdate: async () => {},
    // KI-Auswertung mit hinterlegtem Schlüssel (Knopf rechts neben den Tabs sichtbar), MCP-Server eingeschaltet
    aiKeyState: async () => P.ki === false ? { set:false } : { set:true, hint:'sk-ant-…x7Qa' },
    aiSetKey: async () => ({ set:true, hint:'sk-ant-…x7Qa' }),
    aiTest: async () => ({ ok:true }),
    aiCreate: async () => ({ error:{ kind:'offline' } }),
    mcpInfo: async () => ({ on:true, running:true, port:3917, error:'', url:'http://127.0.0.1:3917/mcp',
      desktop:{ mcpServers:{ 'mm-flight-analyzer':{ command:'/Applications/MM Flight Analyzer.app/Contents/MacOS/MM Flight Analyzer',
        args:['/Applications/MM Flight Analyzer.app/Contents/Resources/mcp-stdio.js'], env:{ ELECTRON_RUN_AS_NODE:'1' } } } } }),
    copyText: async () => {},
    // Eigene Widgets von GitHub (Stand nach dem Holen)
    widgetInfo: async () => ({ repo:'mrskynavi/mm-ethos-widgets', branch:'main', dir:'/Users/christoph/Documents/MM Flight Analyzer/Widgets', auto:true, off:['gpscourse'],
      widgets:[['sollfahrt','Sollfahrt','1.1'],['polarflug','Polarflug','1.1'],['thermik','Thermik','1.0'],['steigfluege','Steigflüge','1.0'],['wind','Wind','1.0'],['gpscourse','GPS Course','1.0']].map(([name,title,version])=>({ name, title, version })),
      fetch:{ ok:true, at:Date.parse('2026-10-13T17:40:00+02:00'), loaded:2, same:4 }, copy:null, senders:['/Volumes/RADIO'] }),
    widgetFetch: async () => window.ethosDesktop.widgetInfo(),
    // Simulator: kein Sender mit scripts-Ordner, also die Widgets von GitHub aus dem Benutzerverzeichnis
    simScripts: async () => ({ source:'github', dir:'/Users/christoph/Documents/MM Flight Analyzer/Widgets/scripts',
      files:{ 'sollfahrt/main.lua':document.getElementById('simW_sollf').textContent, 'thermik/main.lua':document.getElementById('simW_therm').textContent,
        'steigfluege/main.lua':document.getElementById('simW_climb').textContent } }),
    simWrite: async rel => '/Users/christoph/Documents/MM Flight Analyzer/Widgets/scripts/' + rel,
    widgetCopy: async () => ({ copied:5 }),
  };
  window.__setSync = s => { window.__STATUS = s; syncCbs.forEach(cb => cb(s)); };
})();
