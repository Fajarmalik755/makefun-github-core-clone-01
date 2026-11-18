// The entry's HTTP surface: the router. main.ts (lifecycle) is untouched; this file dispatches
// each request to the surface module that owns it, in order: git smart HTTP, REST v3, GraphQL v4,
// MCP. Anything else is GitHub's JSON 404. /healthz takes no auth.
//
// Handler contract (see ../notes/STORE.md — kept out of the entry):
//   handleX(store, ctx, req) => Promise<Resp | null>; null = not this module's route.
//   Req  = { method, path, query: URLSearchParams, headers: Record<string,string>, body: Buffer }
//   Resp = { status, headers?, body: Buffer | string | object }
//   Ctx  = { token: string | undefined }  (the Authorization Bearer value, if present)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, type Ctx, type Handler, type Req, type Resp } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(', ');
  }
  return out;
}

function bearerToken(headers: Record<string, string>): string | undefined {
  const value = headers['authorization'];
  if (typeof value !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/.exec(value.trim());
  return match ? match[1] : undefined;
}

function sendResp(res: ServerResponse, resp: Resp): void {
  const body: Buffer =
    Buffer.isBuffer(resp.body)
      ? resp.body
      : Buffer.from(typeof resp.body === 'string' ? resp.body : `${JSON.stringify(resp.body)}\n`, 'utf8');
  const headers: Record<string, string> = { 'content-length': String(body.length), ...(resp.headers ?? {}) };
  if (!headers['content-type']) headers['content-type'] = JSON_TYPE;
  res.writeHead(resp.status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  sendResp(res, { status, headers, body });
}

const HANDLERS: readonly Handler[] = [handleGit, handleRest, handleGraphql, handleMcp];

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const headers = headersOf(req);
      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const ctx: Ctx = { token: bearerToken(headers) };
        const request: Req = { method, path, query: queryOf(req), headers, body };
        for (const handle of HANDLERS) {
          const answered = await handle(store, ctx, request);
          if (answered !== null) {
            sendResp(res, answered);
            return;
          }
        }
        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never let one request kill the server: answer 500 and keep serving.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          try {
            res.destroy();
          } catch {
            // Nothing left to do for this socket.
          }
        }
      }
    })();
  });
}
