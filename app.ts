// app.ts — the single HTTP server for the forge.
//
// Routes:
//   /{owner}/{repo}.git/*   git smart HTTP (upload-pack, receive-pack)
//   /api/v3/*              REST v3 (see rest.ts: handleRest)
//   /api/graphql           GraphQL v4 (see graphql.ts)
//   /mcp                   MCP over Streamable HTTP (see mcp.ts)
//
// Every reply is application/json (except git endpoints) and carries a
// non-empty X-GitHub-Request-Id. Auth is a Bearer token equal to the
// process's MAKEFUN_SHOP_TOKEN; the token names the viewer `adaiversen`.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  decodePktLines,
  fetchV0Response,
  fetchV2Response,
  lsRefsResponse,
  receivePackAdvertisement,
  receivePackResponse,
  uploadPackAdvertisement,
} from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestReply } from './rest.ts';
import type { Store } from './store.ts';

const JSON_MIME = 'application/json';

export function makeToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

let requestCounter = 0;

export function requestId(): string {
  // Deterministic: a per-process counter, not wall clock or Math.random, so a
  // replayed trial produces the same state.
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}`;
}

export interface AppOptions {
  store: Store;
  token: string;
}

export function createApp(options: AppOptions) {
  const { store, token } = options;

  function reply(res: ServerResponse, status: number, body: string | Buffer, contentType = JSON_MIME): void {
    res.writeHead(status, {
      'content-type': contentType,
      'x-github-request-id': requestId(),
      'cache-control': 'no-cache',
    });
    res.end(body);
  }

  function json(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
    res.writeHead(status, {
      'content-type': JSON_MIME,
      'x-github-request-id': requestId(),
      'cache-control': 'no-cache',
      ...extraHeaders,
    });
    res.end(JSON.stringify(value));
  }

  function jsonError(res: ServerResponse, status: number, message: string): void {
    json(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
  }

  function isAuthed(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match) return false;
    if (token === '') return true;
    return match[1] === token;
  }

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  function sendRest(res: ServerResponse, result: RestReply): void {
    if (result.body === null) {
      res.writeHead(result.status, {
        'x-github-request-id': requestId(),
        'cache-control': 'no-cache',
        ...lowerHeaders(result.headers),
      });
      res.end();
      return;
    }
    json(res, result.status, result.body, lowerHeaders(result.headers));
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        jsonError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const path = decodeURIComponent(url.pathname);

    // --- boot probe: no auth, always 200 ---
    if (method === 'GET' && path === '/healthz') {
      return json(res, 200, { ok: true });
    }

    // --- git smart HTTP (driven anonymously by the suite; repos are
    // addressed by owner/repo in the path) ---
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
    if (gitMatch) {
      const [, owner, repoName, action] = gitMatch;
      const repo = store.getRepo(owner!, repoName!);
      if (method === 'GET' && action === 'info/refs') {
        const service = url.searchParams.get('service');
        if (!repo) return jsonError(res, 404, 'Repository not found');
        if (service === 'git-upload-pack') {
          const version = (req.headers['git-protocol'] ?? '') as string;
          const out = uploadPackAdvertisement(repo, version.includes('version=2'));
          return reply(res, 200, out, 'application/x-git-upload-pack-advertisement');
        }
        if (service === 'git-receive-pack') {
          const out = receivePackAdvertisement(repo);
          return reply(res, 200, out, 'application/x-git-receive-pack-advertisement');
        }
        return jsonError(res, 400, 'unknown service');
      }
      if (method === 'POST' && (action === 'git-upload-pack' || action === 'git-receive-pack')) {
        if (!repo) return jsonError(res, 404, 'Repository not found');
        const body = await readBody(req);
        try {
          if (action === 'git-receive-pack') {
            return reply(res, 200, receivePackResponse(repo, body), 'application/x-git-receive-pack-result');
          }
          const isV2 = (req.headers['git-protocol'] as string | undefined)?.includes('version=2') ?? false;
          if (isV2) {
            const first = decodePktLines(body).find((packet) => packet.kind === 'data' && packet.payload);
            const command = first?.payload?.toString('utf8').trim() ?? '';
            const out = command === 'command=ls-refs' ? lsRefsResponse(repo, body) : fetchV2Response(repo, body);
            return reply(res, 200, out, 'application/x-git-upload-pack-result');
          }
          return reply(res, 200, fetchV0Response(repo, body), 'application/x-git-upload-pack-result');
        } catch (err) {
          return jsonError(res, 400, err instanceof Error ? err.message : 'malformed request');
        }
      }
      return jsonError(res, 404, 'Not Found');
    }

    // --- MCP ---
    if (path === '/mcp') {
      if (method !== 'POST') return jsonError(res, 405, 'Method Not Allowed');
      if (!isAuthed(req)) return jsonError(res, 401, 'Requires authentication');
      const raw = await readBody(req);
      const result = handleMcp(raw.toString('utf8'), store);
      const headers: Record<string, string> = {
        'content-type': JSON_MIME,
        'x-github-request-id': requestId(),
      };
      if (result.headers) Object.assign(headers, result.headers);
      res.writeHead(result.status, headers);
      res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
      return;
    }

    // --- GraphQL ---
    if (path === '/api/graphql') {
      if (method !== 'POST') return jsonError(res, 405, 'Method Not Allowed');
      if (!isAuthed(req)) return jsonError(res, 401, 'Requires authentication');
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return jsonError(res, 400, 'Problems parsing JSON');
      }
      if (Array.isArray(parsed)) {
        const results = parsed.map((entry) => {
          if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'Invalid request' }] };
          const { query, variables } = entry as { query?: unknown; variables?: unknown };
          if (typeof query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
          return executeGraphQL(store, query, (variables ?? {}) as Record<string, unknown>);
        });
        return json(res, 200, results);
      }
      const { query, variables } = (parsed ?? {}) as { query?: unknown; variables?: unknown };
      if (typeof query !== 'string') return jsonError(res, 400, 'query is required');
      return json(res, 200, executeGraphQL(store, query, (variables ?? {}) as Record<string, unknown>));
    }

    // --- REST v3 ---
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (!isAuthed(req)) return jsonError(res, 401, 'Requires authentication');
      let body: unknown = undefined;
      if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            return jsonError(res, 400, 'Problems parsing JSON');
          }
        }
      }
      const parts = path.slice('/api/v3'.length).split('/').filter((part) => part !== '');
      const result = handleRest(
        { method, parts: parts.map((part) => decodeURIComponent(part)), query: url.searchParams, body, origin: `http://${req.headers.host ?? '127.0.0.1'}` },
        store,
      );
      if (result === null) return jsonError(res, 404, 'Not Found');
      return sendRest(res, result);
    }

    return jsonError(res, 404, 'Not Found');
  }

  return server;
}

function lowerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}
