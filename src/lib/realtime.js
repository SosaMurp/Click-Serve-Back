const { WebSocketServer } = require('ws');
const { verifyToken } = require('./tokens');

// RNF-12/16/17: canal en tiempo real. Una persona puede tener varias conexiones (varios dispositivos).
const clients = new Map();
let wss = null;
let pingTimer = null;

function register(userId, ws) {
  const id = Number(userId);
  if (!clients.has(id)) clients.set(id, new Set());
  clients.get(id).add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => {
    const set = clients.get(id);
    if (set) {
      set.delete(ws);
      if (set.size === 0) clients.delete(id);
    }
  });
  ws.on('error', () => {});
  ws.send(JSON.stringify({ event: 'conectado', data: { id_usuario: id }, ts: Date.now() }));
}

function attach(server) {
  // Import diferido: auth depende del pool y este módulo se carga antes en algunos scripts.
  const { loadSessionUser } = require('../middleware/auth');
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    try {
      const decoded = verifyToken(url.searchParams.get('token') || '');
      const result = await loadSessionUser(decoded);
      if (result.error) throw new Error(result.error);
      wss.handleUpgrade(req, socket, head, (ws) => register(result.user.id_usuario, ws));
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  pingTimer = setInterval(() => {
    for (const set of clients.values()) {
      for (const ws of set) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, 25000);
  pingTimer.unref();
  return wss;
}

function emitToUser(userId, event, data) {
  if (userId == null) return 0;
  const set = clients.get(Number(userId));
  if (!set) return 0;
  const message = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(message);
  }
  return set.size;
}

function emitToUsers(userIds, event, data) {
  for (const id of new Set(userIds.filter((v) => v != null).map(Number))) emitToUser(id, event, data);
}

function isOnline(userId) {
  return clients.has(Number(userId));
}

function closeAll() {
  if (pingTimer) clearInterval(pingTimer);
  for (const set of clients.values()) for (const ws of set) ws.terminate();
  clients.clear();
  if (wss) wss.close();
  wss = null;
}

module.exports = { attach, emitToUser, emitToUsers, isOnline, closeAll };
