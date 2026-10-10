// Kasjer 3D – serwer multiplayer (Socket.IO). Uruchom: npm install && npm start
// Model gry: host-authoritative. Host (tworzący lobby) liczy symulację sklepu, serwer tylko
// zarządza lobby i przekazuje wiadomości między graczami jednego pokoju.
const http = require('http');
const { Server } = require('socket.io');
const PORT = process.env.PORT || 3000;

const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Kasjer 3D multiplayer server OK'); });
const io = new Server(srv, { cors: { origin: '*' }, maxHttpBufferSize: 2e5, pingInterval: 10000, pingTimeout: 15000 });

const rooms = new Map();           // id -> { id, name, max, need, hostId, started, players: Map(socketId -> nick) }
let RID = 0;
const clean = (s, n) => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, n);
const plist = r => [...r.players].map(([id, nick]) => ({ id, nick }));
const pub = r => ({ id: r.id, name: r.name, cur: r.players.size, max: r.max, need: r.need, started: r.started });
const state = r => ({ ...pub(r), hostId: r.hostId, players: plist(r) });
const list = () => [...rooms.values()].map(pub);
let lastPush = 0, pushTimer = null;
function pushList() {
  const now = Date.now();
  if (now - lastPush < 300) { clearTimeout(pushTimer); pushTimer = setTimeout(pushList, 300); return; }
  lastPush = now; io.emit('lobbies', list());
}
function leave(s) {
  const rid = s.data.room; if (!rid) return;
  const r = rooms.get(rid); s.leave(rid); s.data.room = null; if (!r) return;
  r.players.delete(s.id);
  if (r.players.size === 0) { rooms.delete(rid); }
  else if (s.id === r.hostId) {
    if (r.started) {                       // host wyszedł z trwającej gry -> koniec dla wszystkich
      io.to(rid).emit('g:end', { why: 'host' });
      for (const id of r.players.keys()) { const o = io.sockets.sockets.get(id); if (o) { o.leave(rid); o.data.room = null; } }
      rooms.delete(rid);
    } else {                               // w poczekalni -> nowy host
      r.hostId = r.players.keys().next().value; io.to(rid).emit('lobby:state', state(r));
    }
  } else { io.to(rid).emit('g:left', { id: s.id }); io.to(rid).emit('lobby:state', state(r)); }
  pushList();
}

io.on('connection', s => {
  s.data.room = null;
  s.on('lobbies:get', (_, ack) => { if (typeof ack === 'function') ack(list()); });

  s.on('lobby:create', (d, ack) => {
    if (typeof ack !== 'function') return; d = d || {}; leave(s);
    const max = Math.max(2, Math.min(50, (d.max | 0) || 10)), need = Math.max(2, Math.min(max, (d.need | 0) || 2));
    const r = { id: 'r' + (++RID), name: clean(d.name, 24) || 'Lobby ' + RID, max, need, hostId: s.id, started: false, players: new Map([[s.id, clean(d.nick, 12) || 'Gracz']]) };
    rooms.set(r.id, r); s.join(r.id); s.data.room = r.id;
    ack({ ok: true }); io.to(r.id).emit('lobby:state', state(r)); pushList();
  });

  s.on('lobby:join', (d, ack) => {
    if (typeof ack !== 'function') return; d = d || {};
    let r = d.id ? rooms.get(d.id) : null;
    if (!r && d.name) { const q = clean(d.name, 24).toLowerCase(); r = [...rooms.values()].find(x => x.name.toLowerCase() === q) || [...rooms.values()].find(x => x.name.toLowerCase().includes(q)); }
    if (!r) return ack({ ok: false, err: 'nf' });
    if (r.players.has(s.id)) return ack({ ok: true });
    if (r.players.size >= r.max) return ack({ ok: false, err: 'full' });
    leave(s); r.players.set(s.id, clean(d.nick, 12) || 'Gracz'); s.join(r.id); s.data.room = r.id;
    ack({ ok: true }); io.to(r.id).emit('lobby:state', state(r));
    if (r.started) s.emit('g:start', { hostId: r.hostId, players: plist(r) });   // dołączanie w trakcie gry
    pushList();
  });

  s.on('lobby:leave', () => leave(s));

  s.on('lobby:start', () => {
    const r = rooms.get(s.data.room);
    if (!r || r.hostId !== s.id || r.started || r.players.size < r.need) return;
    r.started = true; io.to(r.id).emit('g:start', { hostId: r.hostId, players: plist(r) }); pushList();
  });

  // --- przekaźniki gry ---
  s.on('g:pos', d => { const rid = s.data.room; if (rid && d && typeof d === 'object') s.to(rid).volatile.emit('g:pos', { id: s.id, x: +d.x, y: +d.y, z: +d.z, yaw: +d.yaw, mv: d.mv ? 1 : 0, att: d.att ? 1 : 0, cp: d.cp | 0 }); });
  s.on('g:state', d => { const r = rooms.get(s.data.room); if (r && r.hostId === s.id) s.to(r.id).volatile.emit('g:state', d); });
  s.on('g:ev', d => { const r = rooms.get(s.data.room); if (r && r.hostId === s.id) s.to(r.id).emit('g:ev', d); });
  s.on('g:act', (m, ack) => {
    const r = rooms.get(s.data.room); if (!r || !r.started || !m || typeof m !== 'object') return ack && ack({ ok: false });
    const host = io.sockets.sockets.get(r.hostId); if (!host) return ack && ack({ ok: false });
    host.timeout(3000).emit('g:act', { from: s.id, t: String(m.t), d: m.d }, (err, res) => { if (typeof ack === 'function') ack(err ? { ok: false } : res); });
  });

  s.on('disconnect', () => leave(s));
});

srv.listen(PORT, () => console.log('Kasjer 3D server listening on :' + PORT));
