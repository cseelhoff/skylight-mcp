// Local control panel for running skylight-mcp over an ngrok tunnel.
// `npm run panel` serves a one-page UI on 127.0.0.1 and opens it in the browser.
// Needs `npm run build` first and NGROK_AUTHTOKEN (enterable in the panel).
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import dotenv from 'dotenv';
import ngrok from '@ngrok/ngrok';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENV_FILE = join(ROOT, '.env');
const BUNDLE = join(ROOT, 'dist', 'bundle.js');
const MCP_PORT = 3000;
const FIELDS = ['SKYLIGHT_EMAIL', 'SKYLIGHT_PASSWORD', 'NGROK_AUTHTOKEN'];

const readEnv = () => (existsSync(ENV_FILE) ? dotenv.parse(readFileSync(ENV_FILE)) : {});

// Quoted so '#', spaces and '=' in a password survive dotenv parsing.
const quote = (v) => { const q = [`'`, `"`, '`'].find((c) => !v.includes(c)) ?? `'`; return q + v + q; };

function writeEnv(updates) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  const pending = { ...updates };
  const out = lines.map((line) => {
    const key = line.split('=')[0].trim();
    if (!(key in pending)) return line;
    const value = pending[key];
    delete pending[key];
    return `${key}=${quote(value)}`;
  });
  while (out.length && out.at(-1) === '') out.pop();
  for (const [k, v] of Object.entries(pending)) out.push(`${k}=${quote(v)}`);
  writeFileSync(ENV_FILE, out.join('\n') + '\n');
}

// One-shot stdio session: initialize, then the healthcheck tool, with the
// token cache off so a test never touches the running server's tokens.
function healthcheck(email, password) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUNDLE], {
      cwd: ROOT,
      env: { ...process.env, SKYLIGHT_EMAIL: email, SKYLIGHT_PASSWORD: password, SKYLIGHT_REFRESH_TOKEN: '', SKYLIGHT_TOKEN_CACHE: 'false' },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, message: 'Timed out.' }); }, 90_000);
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      for (const line of out.split('\n')) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 2) continue;
        clearTimeout(timer);
        child.kill();
        const result = JSON.parse(msg.result.content[0].text);
        resolve(result.ok ? { ok: true, message: 'Success: Skylight accepted the login.' } : { ok: false, message: `Failed: ${result.error?.message ?? 'unknown error'}` });
      }
    });
    const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'control-panel', version: '1' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'skylight_healthcheck', arguments: {} } });
  });
}

let server;
async function restartServer() {
  if (!existsSync(BUNDLE)) return 'dist/bundle.js not found. Run `npm run build` first.';
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  const log = openSync(join(ROOT, 'server.log'), 'a');
  server = spawn(process.execPath, [BUNDLE, '--http'], {
    cwd: ROOT,
    env: { ...process.env, ...readEnv(), MCP_HTTP_PORT: String(MCP_PORT) },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  return 'Server started (log: server.log).';
}

let tunnel;
let tunnelError = '';
async function connectTunnel() {
  const { NGROK_AUTHTOKEN, NGROK_DOMAIN } = readEnv();
  if (!NGROK_AUTHTOKEN) { tunnelError = 'Enter your ngrok authtoken, then Save and Restart.'; return; }
  try {
    await tunnel?.close();
    tunnel = await ngrok.forward({ addr: MCP_PORT, authtoken: NGROK_AUTHTOKEN, ...(NGROK_DOMAIN ? { domain: NGROK_DOMAIN } : {}) });
    tunnelError = '';
  } catch (e) {
    tunnel = undefined;
    tunnelError = `ngrok failed: ${e.message}`;
  }
}

function ensureSecret() {
  let { MCP_HTTP_SECRET } = readEnv();
  if (!MCP_HTTP_SECRET) writeEnv({ MCP_HTTP_SECRET: (MCP_HTTP_SECRET = randomBytes(32).toString('hex')) });
  return MCP_HTTP_SECRET;
}

const state = () => {
  const env = readEnv();
  return {
    url: tunnel ? `${tunnel.url()}/mcp/${env.MCP_HTTP_SECRET}` : tunnelError || 'Connecting…',
    ...Object.fromEntries(FIELDS.map((k) => [k, env[k] ?? ''])),
  };
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>Skylight MCP</title>
<style>body{font:14px system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 12px}
label{display:block;margin-top:10px}input{width:100%;box-sizing:border-box;padding:6px}
.row{display:flex;gap:6px}.row input{flex:1}button{padding:6px 14px;margin:14px 6px 0 0}</style>
<label>MCP URL<div class="row"><input id="url" readonly><button id="copy" style="margin:0">Copy</button></div></label>
<label>Skylight email<input id="SKYLIGHT_EMAIL" autocomplete="off"></label>
<label>Skylight password<input id="SKYLIGHT_PASSWORD" type="password" autocomplete="off"></label>
<label>ngrok authtoken<input id="NGROK_AUTHTOKEN" type="password" autocomplete="off"></label>
<button data-act="test">Test</button><button data-act="save">Save</button><button data-act="restart">Restart server</button>
<p id="status"></p>
<script>
const token = new URLSearchParams(location.search).get('t');
const $ = (id) => document.getElementById(id);
const fields = ${JSON.stringify(FIELDS)};
async function call(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'x-panel-token': token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return r.json();
}
async function refresh(fill) {
  const s = await call('/api/state');
  $('url').value = s.url;
  if (fill) for (const f of fields) $(f).value = s[f];
}
$('copy').onclick = () => { navigator.clipboard.writeText($('url').value); $('status').textContent = 'URL copied'; };
for (const b of document.querySelectorAll('[data-act]')) b.onclick = async () => {
  $('status').textContent = 'Working…';
  const values = Object.fromEntries(fields.map((f) => [f, $(f).value]));
  $('status').textContent = (await call('/api/' + b.dataset.act, values)).message;
  refresh(false);
};
refresh(true); setInterval(() => refresh(false), 2000);
</script>`;

const panelToken = randomBytes(24).toString('hex');
const tokenOk = (t) => typeof t === 'string' && t.length === panelToken.length && timingSafeEqual(Buffer.from(t), Buffer.from(panelToken));

const actions = {
  test: (b) => healthcheck(b.SKYLIGHT_EMAIL.trim(), b.SKYLIGHT_PASSWORD),
  save: (b) => {
    writeEnv({ SKYLIGHT_EMAIL: b.SKYLIGHT_EMAIL.trim(), SKYLIGHT_PASSWORD: b.SKYLIGHT_PASSWORD, NGROK_AUTHTOKEN: b.NGROK_AUTHTOKEN.trim() });
    return { message: 'Saved to .env. Restart the server to use it.' };
  },
  restart: async () => {
    const message = await restartServer();
    if (!tunnel) await connectTunnel();
    return { message: tunnelError ? `${message} ${tunnelError}` : message };
  },
};

const panel = createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  // The Host check blocks DNS-rebinding pages; the token blocks everything else.
  const hostOk = req.headers.host === `127.0.0.1:${panel.address().port}`;
  const token = pathname === '/' ? searchParams.get('t') : req.headers['x-panel-token'];
  if (!hostOk || !tokenOk(token)) { res.writeHead(403).end('Forbidden'); return; }
  if (pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE); return; }
  const send = (obj) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
  if (pathname === '/api/state') return send(state());
  const action = req.method === 'POST' && actions[pathname.slice('/api/'.length)];
  if (!action) { res.writeHead(404).end(); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  try { send(await action(JSON.parse(body))); } catch (e) { send({ message: `Failed: ${e.message}` }); }
});

ensureSecret();
console.log(await restartServer());
connectTunnel();
panel.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${panel.address().port}/?t=${panelToken}`;
  console.log(`Control panel: ${url}\nPress Ctrl+C to stop.`);
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, () => {});
});

process.on('SIGINT', () => { server?.kill(); process.exit(0); });
