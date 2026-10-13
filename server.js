// Kasjer 3D – serwer multiplayer (Socket.IO). Uruchom: npm install && npm start
// - lobby są TRWAŁE: nie znikają, gdy twórca wyjdzie (zapis w pliku, domyślnie ./lobbies.json)
// - hasło do lobby, usuwanie lobby przez właściciela, zapis stanu gry (host wysyła go co kilka sekund)
// - przejęcie roli hosta, gdy host wyjdzie, czat tekstowy i sygnalizacja voicechatu (WebRTC)
// UWAGA: darmowy hosting z ulotnym dyskiem (np. Render Free) kasuje plik przy każdym wdrożeniu/uśpieniu.
//        Ustaw zmienną DATA_FILE na ścieżkę na trwałym dysku, jeśli chcesz mieć zapisy na stałe.
const http = require('http'), fs = require('fs'), crypto = require('crypto');
const { Server } = require('socket.io');
const PORT = process.env.PORT || 3000, FILE = process.env.DATA_FILE || './lobbies.json';
const IDLE_DAYS = 14;
// Konta admina: serwer trzyma tylko SKRÓT kodu (SHA-256). Możesz go nadpisać zmienną ADMIN_HASH.
const ADMIN_HASH = process.env.ADMIN_HASH || '469344aecb748d2b606122291e9814d793b8c001a875d6f3b24a015e7a02e8d3';
const ADMINS = ['Czorii', 'INFECTION'], RESERVED = { czorii: 1, infection: 1 };
const sha = x => crypto.createHash('sha256').update(String(x)).digest('hex');

const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Kasjer 3D multiplayer server OK'); });
const io = new Server(srv, { cors: { origin: '*' }, maxHttpBufferSize: 2e5, pingInterval: 10000, pingTimeout: 15000 });

const rooms = new Map();
let RID = 0;
const fixNick = (s, nick) => s.data.admin ? s.data.admin : (RESERVED[nick.toLowerCase()] ? nick + '_' : nick);
const clean = (s, n) => String(s == null ? '' : s).replace(/[<>&"'`]/g, '').trim().slice(0, n);
const hash = (v, salt) => crypto.scryptSync(String(v), salt, 32).toString('hex');

// ---------- zapis na dysk ----------
function loadRooms() {
  try {
    JSON.parse(fs.readFileSync(FILE, 'utf8')).forEach(r => {
      r.players = new Map(); r.hostId = null; r.voice = new Set(); r.bans = r.bans || [];
      rooms.set(r.id, r); RID = Math.max(RID, parseInt(String(r.id).slice(1), 10) || 0);
    });
    console.log('Wczytano lobby:', rooms.size);
  } catch (e) { /* pierwszy start */ }
}
let dirty = null;
function persist() {
  clearTimeout(dirty);
  dirty = setTimeout(() => {
    try {
      fs.writeFileSync(FILE, JSON.stringify([...rooms.values()].map(r => ({
        id: r.id, name: r.name, max: r.max, need: r.need, ver: r.ver, started: r.started,
        ownerH: r.ownerH, passH: r.passH, salt: r.salt, save: r.save, last: r.last, bans: r.bans, cat: r.cat, official: r.official }))));
    } catch (e) { console.log('Zapis nieudany:', e.message); }
  }, 2000);
}
loadRooms();
// 5 oficjalnych serwerów RP (stałe, bez hasła; nie da się ich usunąć)
[['RP: Osiedle Okmiany', 50], ['RP: Halloween Market', 50], ['RP: Sklepowa Mafia', 30], ['RP: Nocna Zmiana', 20], ['RP: Dyskont u Szefa', 50]].forEach(([name, max]) => {
  if ([...rooms.values()].some(r => r.official && r.name === name)) return;
  rooms.set('r' + (++RID), { id: 'r' + RID, name, max, need: 2, ver: 0, started: false, save: null, ownerH: null, salt: crypto.randomBytes(8).toString('hex'),
    passH: null, last: Date.now(), players: new Map(), hostId: null, voice: new Set(), bans: [], cat: 'rp', official: true });
});
persist();

// ---------- widoki ----------
const plist = r => [...r.players].map(([id, p]) => ({ id, nick: p.nick, adm: p.adm || null }));
const pub = (r, owner) => ({ id: r.id, name: r.name, cur: r.players.size, max: r.max, need: r.need, started: r.started, ver: r.ver,
  cat: r.cat || 'normal', official: !!r.official, lock: !!r.passH, mine: !!(owner && r.ownerH && hash(owner, 'o') === r.ownerH) });
const state = r => ({ ...pub(r), hostId: r.hostId, players: plist(r), own: [...r.players].filter(([, p]) => p.own).map(([id]) => id) });
let lastPush = 0, pushTimer = null;
function pushList() {
  const now = Date.now();
  if (now - lastPush < 300) { clearTimeout(pushTimer); pushTimer = setTimeout(pushList, 300); return; }
  lastPush = now; io.emit('lobbies', [...rooms.values()].map(r => pub(r)));
}

// ---------- wyjście z lobby ----------
function leave(s) {
  const rid = s.data.room; if (!rid) return;
  const r = rooms.get(rid); s.leave(rid); s.data.room = null; if (!r) return;
  if (r.voice && r.voice.delete(s.id)) io.to(rid).emit('voice:left', { id: s.id });
  r.players.delete(s.id); r.last = Date.now();
  if (r.players.size === 0) { r.hostId = null; }                       // lobby ZOSTAJE (z zapisem gry)
  else {
    if (s.id === r.hostId) {                                          // przejęcie roli hosta
      r.hostId = r.players.keys().next().value;
      if (r.started) io.to(rid).emit('g:host', { hostId: r.hostId, save: r.save });
    }
    io.to(rid).emit('g:left', { id: s.id });
    io.to(rid).emit('lobby:state', state(r));
  }
  pushList(); persist();
}
function join(s, r, d, own) {
  leave(s);
  if (r.players.size === 0) { r.ver = d.ver | 0 || r.ver; }          // puste lobby przyjmuje wersję wchodzącego
  r.players.set(s.id, { nick: fixNick(s, clean(d.nick, 14) || 'Gracz'), own, adm: s.data.admin || null });
  s.join(r.id); s.data.room = r.id; r.last = Date.now();
  const noHost = !r.hostId || !r.players.has(r.hostId);
  if (noHost) r.hostId = s.id;
  io.to(r.id).emit('lobby:state', state(r));
  if (r.started) s.emit('g:start', { hostId: r.hostId, players: plist(r), save: noHost ? r.save : null });
  pushList(); persist();
}

io.on('connection', s => {
  s.data.room = null; s.data.lastChat = 0; s.data.bad = 0;
  s.data.ip = ((s.handshake && s.handshake.headers && s.handshake.headers['x-forwarded-for']) || '').split(',')[0].trim() || (s.handshake && s.handshake.address) || '';
  const isOwner = (r, tok) => !!(tok && r.ownerH && hash(tok, 'o') === r.ownerH);

  s.on('lobbies:get', (d, ack) => { if (typeof ack === 'function') ack([...rooms.values()].map(r => pub(r, d && d.owner))); });

  s.on('lobby:create', (d, ack) => {
    if (typeof ack !== 'function') return; d = d || {}; s.data.uid = clean(d.uid, 40);
    const max = Math.max(2, Math.min(50, (d.max | 0) || 10)), need = Math.max(2, Math.min(max, (d.need | 0) || 2));
    const salt = crypto.randomBytes(8).toString('hex'), pass = typeof d.pass === 'string' ? d.pass.slice(0, 24) : '';
    const r = { id: 'r' + (++RID), name: clean(d.name, 24) || 'Lobby ' + RID, max, need, ver: d.ver | 0, started: false, save: null,
      ownerH: d.owner ? hash(d.owner, 'o') : null, salt, passH: pass ? hash(pass, salt) : null, last: Date.now(),
      players: new Map(), hostId: null, voice: new Set(), bans: [], cat: d.cat === 'rp' ? 'rp' : 'normal' };
    rooms.set(r.id, r);
    join(s, r, d, true); ack({ ok: true, id: r.id });
  });

  s.on('lobby:join', (d, ack) => {
    if (typeof ack !== 'function') return; d = d || {};
    let r = d.id ? rooms.get(d.id) : null;
    if (!r && d.name) { const q = clean(d.name, 24).toLowerCase(); r = [...rooms.values()].find(x => x.name.toLowerCase() === q) || [...rooms.values()].find(x => x.name.toLowerCase().includes(q)); }
    if (!r) return ack({ ok: false, err: 'nf' });
    s.data.uid = clean(d.uid, 40);
    if (!s.data.admin && r.bans && (r.bans.includes('u:' + s.data.uid) || (s.data.ip && r.bans.includes('i:' + s.data.ip)))) return ack({ ok: false, err: 'ban' });
    const own = isOwner(r, d.owner);
    if (r.passH && !own && !s.data.admin && !(typeof d.pass === 'string' && hash(d.pass, r.salt) === r.passH)) return ack({ ok: false, err: 'pass' });
    if (r.players.has(s.id)) return ack({ ok: true });
    if (r.players.size > 0 && r.ver && (d.ver | 0) !== r.ver) return ack({ ok: false, err: 'ver', hv: r.ver });
    if (r.players.size >= r.max) return ack({ ok: false, err: 'full' });
    join(s, r, d, own); ack({ ok: true });
  });

  s.on('lobby:leave', () => leave(s));

  // ---------- konta admina ----------
  s.on('admin:login', (d, ack) => {
    d = d || {}; const reply = o => typeof ack === 'function' && ack(o);
    if (s.data.bad >= 5) return reply({ ok: false });
    if (sha(d.code) !== ADMIN_HASH || !ADMINS.includes(d.who)) { s.data.bad++; return reply({ ok: false }); }
    s.data.admin = d.who;
    const r = rooms.get(s.data.room), p = r && r.players.get(s.id);
    if (p) { p.adm = d.who; p.nick = d.who; io.to(r.id).emit('lobby:state', state(r)); }
    reply({ ok: true });
  });
  s.on('admin:logout', () => {
    s.data.admin = null;
    const r = rooms.get(s.data.room), p = r && r.players.get(s.id);
    if (p) { p.adm = null; io.to(r.id).emit('lobby:state', state(r)); }
  });
  s.on('admin:ban', (d, ack) => {
    d = d || {}; const r = rooms.get(s.data.room), tg = io.sockets.sockets.get(d.id), reply = o => typeof ack === 'function' && ack(o);
    if (!s.data.admin || !r || !tg || tg.data.room !== r.id || tg.data.admin || tg.id === s.id) return reply({ ok: false });
    r.bans = r.bans || [];
    if (tg.data.uid) r.bans.push('u:' + tg.data.uid);
    if (tg.data.ip) r.bans.push('i:' + tg.data.ip);
    tg.emit('g:banned', {}); leave(tg); persist(); reply({ ok: true });
  });

  s.on('lobby:delete', (d, ack) => {
    d = d || {}; const r = rooms.get(d.id);
    if (!r || !isOwner(r, d.owner)) return typeof ack === 'function' && ack({ ok: false });
    io.to(r.id).emit('g:end', { why: 'deleted' });
    for (const id of r.players.keys()) { const o = io.sockets.sockets.get(id); if (o) { o.leave(r.id); o.data.room = null; } }
    rooms.delete(r.id); pushList(); persist(); if (typeof ack === 'function') ack({ ok: true });
  });

  s.on('nick', n => {
    const r = rooms.get(s.data.room), nick = clean(n, 14), p = r && r.players.get(s.id);
    if (!p || !nick || s.data.admin) return;
    p.nick = fixNick(s, nick); io.to(r.id).emit('lobby:state', state(r));
  });

  s.on('lobby:start', () => {
    const r = rooms.get(s.data.room);
    if (!r || r.hostId !== s.id || r.started || r.players.size < r.need) return;
    r.started = true; r.last = Date.now();
    io.to(r.id).emit('g:start', { hostId: r.hostId, players: plist(r), save: r.save }); pushList(); persist();
  });

  // ---------- gra ----------
  s.on('g:pos', d => { const rid = s.data.room; if (rid && d && typeof d === 'object') s.to(rid).volatile.emit('g:pos', { id: s.id, x: +d.x, y: +d.y, z: +d.z, yaw: +d.yaw, mv: d.mv ? 1 : 0, att: d.att ? 1 : 0, cp: d.cp | 0 }); });
  s.on('g:state', d => { const r = rooms.get(s.data.room); if (r && r.hostId === s.id) s.to(r.id).volatile.emit('g:state', d); });
  s.on('g:ev', d => { const r = rooms.get(s.data.room); if (r && r.hostId === s.id) s.to(r.id).emit('g:ev', d); });
  s.on('g:save', d => {   // zapis stanu świata przez hosta (przetrwa wyjście wszystkich graczy)
    const r = rooms.get(s.data.room);
    if (!r || r.hostId !== s.id || !d || typeof d !== 'object') return;
    let js = ''; try { js = JSON.stringify(d); } catch (e) { return; }
    if (js.length > 60000) return;
    r.save = d; r.last = Date.now(); persist();
  });
  s.on('g:act', (m, ack) => {
    const r = rooms.get(s.data.room); if (!r || !r.started || !m || typeof m !== 'object') return ack && ack({ ok: false });
    const host = io.sockets.sockets.get(r.hostId); if (!host) return ack && ack({ ok: false });
    host.timeout(3000).emit('g:act', { from: s.id, adm: s.data.admin || null, t: String(m.t), d: m.d }, (err, res) => { if (typeof ack === 'function') ack(err ? { ok: false } : res); });
  });

  // ---------- czat ----------
  s.on('chat', txt => {
    const r = rooms.get(s.data.room), p = r && r.players.get(s.id), now = Date.now();
    if (!p || now - s.data.lastChat < 400) return;
    const text = clean(txt, 140); if (!text) return;
    s.data.lastChat = now; io.to(r.id).emit('chat', { id: s.id, nick: p.nick, text });
  });

  // ---------- voicechat (tylko sygnalizacja WebRTC) ----------
  s.on('voice:join', (_, ack) => {
    const r = rooms.get(s.data.room); if (!r) return typeof ack === 'function' && ack([]);
    const others = [...r.voice].filter(id => id !== s.id); r.voice.add(s.id);
    if (typeof ack === 'function') ack(others);
  });
  s.on('voice:leave', () => { const r = rooms.get(s.data.room); if (r && r.voice.delete(s.id)) io.to(r.id).emit('voice:left', { id: s.id }); });
  s.on('rtc', m => {
    const r = rooms.get(s.data.room); if (!r || !m || !r.players.has(m.to)) return;
    const o = io.sockets.sockets.get(m.to); if (o) o.emit('rtc', { from: s.id, d: m.d });
  });

  s.on('disconnect', () => leave(s));
});

// sprzątanie starych, pustych lobby
setInterval(() => {
  const lim = Date.now() - IDLE_DAYS * 864e5; let ch = false;
  for (const [id, r] of rooms) if (!r.official && r.players.size === 0 && (r.last || 0) < lim) { rooms.delete(id); ch = true; }
  if (ch) { persist(); pushList(); }
}, 6 * 3600e3);

srv.listen(PORT, () => console.log('Kasjer 3D server listening on :' + PORT));
