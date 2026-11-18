// mcp.ts — Model Context Protocol (Streamable HTTP, plain-JSON) surface.
//
// Speaks both protocol eras the suite accepts:
//   modern 2026-07-28: `server/discover`, no handshake, no session.
//   legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`.
// Transport: one POST per JSON-RPC request, one plain JSON body back (no SSE).
// Auth is decided before anything else: unauthenticated -> HTTP 401, every method.

import { isAuthed } from './store.ts';
import type { Store } from './store.ts';

/** Mirrors the shared contract in notes/STORE.md (kept local: store.ts owns the Store API). */
export interface Ctx {
  token: string | undefined;
}
export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
}
export interface Resp {
  status: number;
  headers?: Record<string, string>;
  body: Buffer | string | object;
}
export type Handler = (store: Store, ctx: Ctx, req: Req) => Promise<Resp | null>;

const JSON_TYPE = 'application/json; charset=utf-8';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';

/** The revisions this server speaks, newest first. */
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const SERVER_INFO = Object.freeze({ name: SERVER_NAME, version: SERVER_VERSION });
const CAPABILITIES = Object.freeze({ tools: {} });

type JsonRpcId = string | number | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One JSON-RPC success / error body, serialized exactly as the client parses it. */
function rpcBody(id: JsonRpcId, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
}

function rpcErrorBody(id: JsonRpcId, code: number, message: string, data?: unknown): string {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return `${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`;
}

function jsonResp(status: number, body: string): Resp {
  return { status, headers: { 'content-type': JSON_TYPE }, body };
}

function rpcResp(status: number, id: JsonRpcId, result: unknown): Resp {
  return jsonResp(status, rpcBody(id, result));
}

function rpcErrorResp(status: number, id: JsonRpcId, code: number, message: string, data?: unknown): Resp {
  return jsonResp(status, rpcErrorBody(id, code, message, data));
}

/** A tool success: text is the compact JSON of the result object; structuredContent carries the same object. */
function toolOk(result: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

/** A tool execution error: isError:true with the message as the text block. */
function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// --------------------------------------------------------------------------- tools

/**
 * The tool list. A single module-level constant, never rebuilt: tools/list must
 * answer byte-identical JSON on every call (the suite compares JSON.stringify across calls).
 */
const TOOLS = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The name of the repository to create.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'The title of the issue.' }),
        body: Object.freeze({ type: 'string', description: 'The body of the issue.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        state: Object.freeze({ type: 'string', description: 'Issue state filter: open, closed, or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'The title of the pull request.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch of the pull request.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch of the pull request.' }),
        body: Object.freeze({ type: 'string', description: 'The body of the pull request.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and close it.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The number of the pull request to merge.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

// --------------------------------------------------------------------------- argument helpers

/**
 * Pick the first present argument under any of the given names. The suite maps its
 * documented names onto this schema's property names, so the canonical name is
 * normally the one present; the synonyms are a cheap safety net.
 */
function pick(args: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

// --------------------------------------------------------------------------- tool implementations

/** Dispatch one tools/call. Returns a tool result object (never throws for bad input). */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = asNonEmptyString(pick(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']));
      if (repoName === null) return toolErr('create_repo requires a non-empty name');
      const description = asString(pick(args, ['description', 'about', 'summary', 'body']), '');
      const isPrivate = asBoolean(pick(args, ['private', 'is_private']), false);
      const repo = store.createRepo(repoName, description, isPrivate);
      if (repo === null) return toolErr(`repository already exists: ${repoName}`);
      return toolOk({
        full_name: repo.fullName(),
        name: repo.name,
        id: repo.id,
        private: repo.private,
        description: repo.description,
      });
    }
    case 'get_repo': {
      const owner = asNonEmptyString(pick(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login']));
      const repoName = asNonEmptyString(pick(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug']));
      if (owner === null || repoName === null) return toolErr('get_repo requires owner and repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`not found: ${owner}/${repoName}`);
      return toolOk({
        full_name: repo.fullName(),
        name: repo.name,
        id: repo.id,
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'create_issue': {
      const owner = asNonEmptyString(pick(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login']));
      const repoName = asNonEmptyString(pick(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug']));
      const title = asNonEmptyString(pick(args, ['title', 'issue_title', 'subject']));
      if (owner === null || repoName === null || title === null) {
        return toolErr('create_issue requires owner, repo, and a non-empty title');
      }
      const body = asString(pick(args, ['body', 'issue_body', 'description', 'content', 'text']), '');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`not found: ${owner}/${repoName}`);
      const issue = store.createIssue(repo, title, body, []);
      if (isRecord(issue) && 'error' in issue) return toolErr(`create_issue failed: ${String(issue.error)}`);
      if (!isRecord(issue) || typeof issue.number !== 'number') return toolErr('create_issue failed');
      return toolOk({
        number: issue.number,
        id: `issue-${repo.id}-${issue.number}`,
        title: issue.title,
        state: 'open',
        body: issue.body,
      });
    }
    case 'list_issues': {
      const owner = asNonEmptyString(pick(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login']));
      const repoName = asNonEmptyString(pick(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug']));
      if (owner === null || repoName === null) return toolErr('list_issues requires owner and repo');
      const state = asString(pick(args, ['state', 'status']), 'all');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`not found: ${owner}/${repoName}`);
      const issues = repo.issues
        .filter((issue) => state === 'all' || state === '' || issue.state === state)
        .map((issue) => ({
          number: issue.number,
          id: `issue-${repo.id}-${issue.number}`,
          title: issue.title,
          state: issue.state,
          body: issue.body,
        }));
      return toolOk({ issues });
    }
    case 'create_pull_request': {
      const owner = asNonEmptyString(pick(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login']));
      const repoName = asNonEmptyString(pick(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug']));
      const title = asNonEmptyString(pick(args, ['title', 'pr_title', 'pull_request_title', 'subject']));
      const head = asNonEmptyString(
        pick(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from_branch']),
      );
      const base = asNonEmptyString(
        pick(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into_branch']),
      );
      if (owner === null || repoName === null || title === null || head === null || base === null) {
        return toolErr('create_pull_request requires owner, repo, title, head, and base');
      }
      const body = asString(pick(args, ['body', 'issue_body', 'description', 'content', 'text']), '');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`not found: ${owner}/${repoName}`);
      const pull = store.createPull(repo, title, body, head, base);
      if (isRecord(pull) && 'error' in pull) return toolErr(`create_pull_request failed: ${String(pull.error)}`);
      if (!isRecord(pull) || typeof pull.number !== 'number') return toolErr('create_pull_request failed');
      return toolOk({
        number: pull.number,
        id: `pull-${repo.id}-${pull.number}`,
        title: pull.title,
        state: 'open',
        head: { ref: head },
        base: { ref: base },
      });
    }
    case 'merge_pull_request': {
      const owner = asNonEmptyString(pick(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login']));
      const repoName = asNonEmptyString(pick(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug']));
      const pullNumber = asInteger(pick(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']));
      if (owner === null || repoName === null || pullNumber === null) {
        return toolErr('merge_pull_request requires owner, repo, and pull_number');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`not found: ${owner}/${repoName}`);
      const merged = store.mergePull(repo, pullNumber, 'squash');
      if (isRecord(merged) && 'error' in merged) {
        return toolErr(`merge_pull_request failed: ${String(merged.error)}`);
      }
      return toolOk({ number: pullNumber, merged: true, state: 'closed' });
    }
    default:
      // Unknown tool names are reported by the caller as JSON-RPC -32602; unreachable here.
      return toolErr(`unknown tool: ${name}`);
  }
}

// --------------------------------------------------------------------------- handler

/**
 * Best-effort extraction of a JSON-RPC id from a body that failed to parse
 * (e.g. truncated JSON), so the -32700 answer can still echo the request id.
 */
function extractIdFromBrokenJson(text: string): JsonRpcId {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(text);
  if (match === null) return null;
  const raw = match[1]!;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return null;
    }
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export const handleMcp: Handler = async (store, ctx, req) => {
  if (req.path !== '/mcp') return null;
  if (req.method !== 'POST' && req.method !== 'DELETE') return null;

  // Auth first: before parsing, before the tool name is even considered.
  if (!isAuthed(ctx)) {
    return jsonResp(401, `${JSON.stringify({ message: 'Unauthorized' })}\n`);
  }

  // DELETE closes a session best-effort (legacy clients send it on close()).
  if (req.method === 'DELETE') {
    return { status: 200, headers: { 'content-type': JSON_TYPE }, body: '' };
  }

  const text = req.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return rpcErrorResp(400, extractIdFromBrokenJson(text), -32700, 'Parse error');
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    const id: JsonRpcId =
      isRecord(parsed) && (typeof parsed.id === 'string' || typeof parsed.id === 'number') ? parsed.id : null;
    return rpcErrorResp(400, id, -32600, 'Invalid Request');
  }

  const method = parsed.method;
  const params: Record<string, unknown> = isRecord(parsed.params) ? parsed.params : {};
  // A request without an id is a notification: no JSON-RPC response object.
  const hasId = parsed.id !== undefined;
  const id: JsonRpcId =
    typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null;

  if (!hasId) {
    // notifications/initialized (and any other notification): 200, empty body.
    return { status: 200, headers: { 'content-type': JSON_TYPE }, body: '' };
  }

  switch (method) {
    case 'server/discover': {
      // Always succeed with the full supported list; no strict negotiation.
      return rpcResp(200, id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(offered) ? offered : '2025-11-25';
      return rpcResp(200, id, {
        protocolVersion,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
    }
    case 'notifications/initialized': {
      return { status: 200, headers: { 'content-type': JSON_TYPE }, body: '' };
    }
    case 'tools/list': {
      return rpcResp(200, id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args: Record<string, unknown> = isRecord(params.arguments) ? params.arguments : {};
      const known = TOOLS.some((tool) => tool.name === name);
      if (!known) {
        return rpcErrorResp(200, id, -32602, `Unknown tool: ${name}`);
      }
      const result = callTool(store, name, args);
      return rpcResp(200, id, result);
    }
    default: {
      return rpcErrorResp(200, id, -32601, `Method not found: ${method}`);
    }
  }
};
