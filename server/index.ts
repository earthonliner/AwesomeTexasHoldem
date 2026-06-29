import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room } from './room';
import { WS_PATH, type ClientMsg } from '../src/online/protocol';

const PORT = Number(process.env.PORT ?? 8080);
const DIST = fileURLToPath(new URL('../dist', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const room = new Room();

const httpServer = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let filePath = normalize(join(DIST, urlPath === '/' ? 'index.html' : urlPath));
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let body: Buffer;
    try {
      const s = await stat(filePath);
      if (s.isDirectory()) filePath = join(filePath, 'index.html');
      body = await readFile(filePath);
    } catch {
      // SPA fallback: serve index.html for unknown routes.
      try {
        body = await readFile(join(DIST, 'index.html'));
        filePath = join(DIST, 'index.html');
      } catch {
        res.writeHead(404).end(
          'dist/ not found. Run `npm run build` first, then `npm run server`.',
        );
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(500).end('Server error');
  }
});

const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });

wss.on('connection', (ws: WebSocket) => {
  const clientId = randomUUID();
  room.addConnection({ id: clientId, send: (data) => ws.readyState === ws.OPEN && ws.send(data) });

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      return;
    }
    const welcome = room.handle(clientId, msg);
    if (welcome) {
      ws.send(JSON.stringify({ t: 'welcome', youId: welcome.youId, token: welcome.token }));
      ws.send(JSON.stringify({ t: 'view', view: room.viewFor(clientId) }));
    }
  });

  ws.on('close', () => room.removeConnection(clientId));
  ws.on('error', () => room.removeConnection(clientId));
});

httpServer.listen(PORT, () => {
  const addrs = lanAddresses();
  console.log('德州扑克 局域网服务器已启动 / Texas Poker LAN server running');
  console.log(`  本机:    http://localhost:${PORT}`);
  for (const ip of addrs) console.log(`  局域网:  http://${ip}:${PORT}   <- 同一 Wi-Fi 的其他设备用这个地址`);
  if (addrs.length === 0) console.log('  (未检测到局域网 IP，请确认已联网)');
  console.log('提示：其他玩家在浏览器打开上面的局域网地址，选择“局域网联机”即可加入。');
});

function lanAddresses(): string[] {
  const out: string[] = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}
