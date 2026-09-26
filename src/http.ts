import { createServer, type Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpHandler, type McpServerFactory } from '@modelcontextprotocol/server';
import { toNodeHandler, type FetchLikeMcpHandler } from '@modelcontextprotocol/node';

export const MCP_PATH = '/mcp';
export const MIN_SECRET_LENGTH = 32;

export interface HttpConfig {
  port: number;
  host: string;
  secret: string;
}

// The secret doubles as a URL path segment for clients that can only be given a
// URL, so it must be URL-safe as well as long enough to be unguessable.
export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const secret = env.MCP_HTTP_SECRET ?? '';
  if (secret.length < MIN_SECRET_LENGTH || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new Error(
      `MCP_HTTP_SECRET must be at least ${MIN_SECRET_LENGTH} characters of [A-Za-z0-9_-]. ` +
      'Generate one with: openssl rand -hex 32',
    );
  }
  const port = Number(env.MCP_HTTP_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MCP_HTTP_PORT must be an integer between 1 and 65535, got "${env.MCP_HTTP_PORT}".`);
  }
  return { port, host: env.MCP_HTTP_HOST || '127.0.0.1', secret };
}

/**
 * The secret is accepted either as `Authorization: Bearer <secret>` on `/mcp`,
 * or as the path segment in `/mcp/<secret>`.
 */
export function presentedSecret(request: Request): string | undefined {
  const { pathname } = new URL(request.url);
  if (pathname === MCP_PATH) {
    return /^Bearer (.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  }
  if (pathname.startsWith(`${MCP_PATH}/`)) return pathname.slice(MCP_PATH.length + 1);
  return undefined;
}

// Hashing both sides first gives timingSafeEqual equal-length inputs, so the
// comparison leaks neither the secret's content nor its length.
function secretMatches(candidate: string, secret: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(candidate), digest(secret));
}

// Only MCP paths answer 401: a 401 carrying WWW-Authenticate on OAuth discovery
// paths (/.well-known/…) makes clients such as Grok start an OAuth flow this
// server does not offer.
export function requireSecret(handler: FetchLikeMcpHandler, secret: string): FetchLikeMcpHandler {
  return {
    fetch: async (request, options) => {
      const { pathname } = new URL(request.url);
      if (pathname !== MCP_PATH && !pathname.startsWith(`${MCP_PATH}/`)) {
        return new Response('Not Found', { status: 404 });
      }
      const candidate = presentedSecret(request);
      if (candidate === undefined || !secretMatches(candidate, secret)) {
        return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
      }
      return handler.fetch(request, options);
    },
  };
}

export async function serveHttp(
  factory: McpServerFactory,
  config: HttpConfig,
  onerror: (error: Error) => void,
): Promise<Server> {
  const mcp = createMcpHandler(factory, { onerror });
  const handle = toNodeHandler(requireSecret(mcp, config.secret), { onerror });
  const server = createServer((req, res) => void handle(req, res));
  server.on('close', () => void mcp.close());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
