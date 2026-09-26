import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMcpServer } from '@chrischall/mcp-utils';
import { registerHealthcheckTools } from '../src/tools/health.js';
import { makeGetClient } from '../src/get-client.js';
import { loadHttpConfig, presentedSecret, requireSecret, serveHttp, MIN_SECRET_LENGTH } from '../src/http.js';

const SECRET = 'a'.repeat(MIN_SECRET_LENGTH);

describe('loadHttpConfig', () => {
  it('defaults to localhost:3000', () => {
    expect(loadHttpConfig({ MCP_HTTP_SECRET: SECRET })).toEqual({ port: 3000, host: '127.0.0.1', secret: SECRET });
  });

  it('reads port and host overrides', () => {
    expect(loadHttpConfig({ MCP_HTTP_SECRET: SECRET, MCP_HTTP_PORT: '8080', MCP_HTTP_HOST: '0.0.0.0' }))
      .toEqual({ port: 8080, host: '0.0.0.0', secret: SECRET });
  });

  it.each([
    ['missing', undefined],
    ['too short', 'a'.repeat(MIN_SECRET_LENGTH - 1)],
    ['not URL-safe', `${'a'.repeat(MIN_SECRET_LENGTH)}/x`],
  ])('rejects a %s secret', (_label, secret) => {
    expect(() => loadHttpConfig({ MCP_HTTP_SECRET: secret })).toThrow(/MCP_HTTP_SECRET/);
  });

  it.each(['0', '65536', 'abc', '1.5'])('rejects port %s', (port) => {
    expect(() => loadHttpConfig({ MCP_HTTP_SECRET: SECRET, MCP_HTTP_PORT: port })).toThrow(/MCP_HTTP_PORT/);
  });
});

describe('presentedSecret', () => {
  const req = (path: string, headers: Record<string, string> = {}) => new Request(`http://x${path}`, { headers });

  it('reads a bearer token on /mcp', () => {
    expect(presentedSecret(req('/mcp', { Authorization: 'Bearer abc' }))).toBe('abc');
    expect(presentedSecret(req('/mcp', { Authorization: 'bearer abc' }))).toBe('abc');
  });

  it('returns undefined on /mcp without a bearer token', () => {
    expect(presentedSecret(req('/mcp'))).toBeUndefined();
    expect(presentedSecret(req('/mcp', { Authorization: 'Basic abc' }))).toBeUndefined();
  });

  it('reads the path segment on /mcp/<secret>, ignoring any header', () => {
    expect(presentedSecret(req('/mcp/abc', { Authorization: 'Bearer other' }))).toBe('abc');
  });

  it('returns undefined for any other path', () => {
    expect(presentedSecret(req('/'))).toBeUndefined();
    expect(presentedSecret(req('/mcpx'))).toBeUndefined();
  });
});

describe('requireSecret', () => {
  const inner = { fetch: vi.fn(async () => new Response('ok')) };
  const guarded = requireSecret(inner, SECRET);

  it.each([
    ['no credential', '/mcp', {}],
    ['a wrong bearer token', '/mcp', { Authorization: 'Bearer nope' }],
    ['a wrong path secret', '/mcp/nope', {}],
    ['an unknown path', '/', { Authorization: `Bearer ${SECRET}` }],
  ])('answers 401 for %s without reaching the MCP handler', async (_label, path, headers) => {
    inner.fetch.mockClear();
    const response = await guarded.fetch(new Request(`http://x${path}`, { headers }));
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(inner.fetch).not.toHaveBeenCalled();
  });

  it('passes a matching secret through', async () => {
    const response = await guarded.fetch(new Request(`http://x/mcp/${SECRET}`));
    expect(await response.text()).toBe('ok');
  });
});

describe('serveHttp', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise((resolve) => (server?.listening ? server.close(resolve) : resolve(undefined)));
    server = undefined;
    vi.unstubAllEnvs();
  });

  async function start() {
    vi.stubEnv('SKYLIGHT_EMAIL', '');
    vi.stubEnv('SKYLIGHT_PASSWORD', '');
    vi.stubEnv('SKYLIGHT_REFRESH_TOKEN', '');
    const getClient = makeGetClient();
    server = await serveHttp(
      () => createMcpServer({ name: 'skylight-mcp', version: 'test', deps: getClient, tools: [registerHealthcheckTools] }),
      { port: 0, host: '127.0.0.1', secret: SECRET },
      () => {},
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function listTools(url: string, headers: Record<string, string> = {}) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
  }

  function parse(text: string) {
    return JSON.parse(text.startsWith('event:') ? text.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : text);
  }

  it('serves tools/list to a bearer-authenticated legacy client', async () => {
    const base = await start();
    const response = await listTools(`${base}/mcp`, { Authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(200);
    expect(parse(await response.text()).result.tools.map((t: { name: string }) => t.name)).toEqual(['skylight_healthcheck']);
  });

  it('serves tools/list to a client that holds the secret URL', async () => {
    const base = await start();
    const response = await listTools(`${base}/mcp/${SECRET}`);
    expect(response.status).toBe(200);
    expect(parse(await response.text()).result.tools).toHaveLength(1);
  });

  it('refuses an unauthenticated request', async () => {
    const base = await start();
    expect((await listTools(`${base}/mcp`)).status).toBe(401);
  });

  it('rejects when the port cannot be bound', async () => {
    const base = await start();
    const port = Number(new URL(base).port);
    await expect(serveHttp(() => { throw new Error('unused'); }, { port, host: '127.0.0.1', secret: SECRET }, () => {}))
      .rejects.toThrow(/EADDRINUSE/);
  });
});
