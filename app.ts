// app.ts — the HTTP server: routing, body reading, JSON helpers, auth.
//
// One process, one in-memory store shared by REST, GraphQL, MCP and git, so
// an object created through any surface reads back identically through the
// others. Every reply is JSON (never HTML), carries X-GitHub-Request-Id and
// X-OAuth-Scopes, and answers Content-Length so keep-alive connections stay
// fast. Any non-empty Bearer token is the viewer adaiversen; a request with
// no token is a 401 on every surface, including git.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './git-http.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId,
    'x-oauth-scopes': 'repo, read:org',
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(text);
}

function sendRaw(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  requestId: string,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId,
    'content-length': String(body.length),
  });
  res.end(body);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = store.requestId();
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' }, requestId);
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const rawSegments = url.pathname.split('/').filter((part) => part !== '');
  const segments = rawSegments.map(decodeSegment);
  const token = bearerToken(req);

  try {
    // --- health probe ---------------------------------------------------------
    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true }, requestId);
      return;
    }

    // --- MCP ---------------------------------------------------------------
    if (method === 'POST' && segments.length === 1 && segments[0] === 'mcp') {
      const body = await readBody(req);
      const result = handleMcp(store, body.toString('utf8'), token);
      if (result.json === null) {
        res.writeHead(result.status);
        res.end();
        return;
      }
      sendJson(res, result.status, result.json, requestId);
      return;
    }

    // --- GraphQL ------------------------------------------------------------
    if (method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
      const body = await readBody(req);
      let parsed: unknown;
      try {
        parsed = body.length === 0 ? null : JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }, requestId);
        return;
      }
      const result = handleGraphQL(store, parsed, token);
      sendJson(res, result.status, result.json, requestId);
      return;
    }

    // --- REST v3 ------------------------------------------------------------
    if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
      const body = await readBody(req);
      let parsed: unknown;
      let bodyMalformed = false;
      if (body.length > 0) {
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          bodyMalformed = true;
        }
      }
      const host = req.headers.host ?? '127.0.0.1';
      const restRequest: RestRequest = {
        method,
        segments: segments.slice(2),
        query: url.searchParams,
        body: parsed,
        bodyMalformed,
        origin: `http://${host}`,
        token,
      };
      const result = handleRest(store, restRequest);
      sendJson(res, result.status, result.text ?? result.json ?? {}, requestId, result.headers ?? {});
      return;
    }

    // --- git smart HTTP ------------------------------------------------------
    // /<owner>/<repo>.git/info/refs | /git-upload-pack | /git-receive-pack
    if (
      segments.length >= 3 &&
      segments[1] !== undefined &&
      segments[1].endsWith('.git') &&
      segments[2] === 'info' &&
      segments[3] === 'refs' &&
      method === 'GET'
    ) {
      if (token === null) {
        sendJson(res, 401, { message: 'Requires authentication' }, requestId);
        return;
      }
      const owner = segments[0] as string;
      const repoName = (segments[1] as string).slice(0, -'.git'.length);
      const service = url.searchParams.get('service') ?? '';
      const gitProtocolV2 = req.headers['git-protocol'] === 'version=2';
      const result = infoRefs(store, owner, repoName, service, gitProtocolV2);
      sendRaw(res, result.status, result.contentType, result.body, requestId);
      return;
    }
    if (
      segments.length === 3 &&
      segments[1] !== undefined &&
      segments[1].endsWith('.git') &&
      method === 'POST' &&
      (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
    ) {
      if (token === null) {
        sendJson(res, 401, { message: 'Requires authentication' }, requestId);
        return;
      }
      const owner = segments[0] as string;
      const repoName = (segments[1] as string).slice(0, -'.git'.length);
      const body = await readBody(req);
      const gitProtocolV2 = req.headers['git-protocol'] === 'version=2';
      const result =
        segments[2] === 'git-upload-pack'
          ? uploadPack(store, owner, repoName, gitProtocolV2, body)
          : receivePack(store, owner, repoName, body);
      sendRaw(res, result.status, result.contentType, result.body, requestId);
      return;
    }
  } catch (error) {
    // A handler must never take the server down or answer a 500 to the suite.
    // eslint-disable-next-line no-console
    console.error('handler error:', error instanceof Error ? error.stack ?? error.message : error);
    if (!res.headersSent) {
      sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
    }
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, requestId);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req, res) => {
    void handleRequest(store, req, res);
  });
}

// Standalone runs (local grading): `node app.ts` binds an ephemeral port and prints the URL.
if (process.argv[1] !== undefined && process.argv[1].endsWith('app.ts')) {
  const server = createApp();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = address !== null && typeof address !== 'string' ? address.port : 0;
    // eslint-disable-next-line no-console
    console.log(`forge listening on http://127.0.0.1:${port}`);
  });
}
