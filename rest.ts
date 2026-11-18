// REST v3 surface for github-core-clone-01.
//
// Exports handleRest(store, ctx, req): Promise<Resp | null>.
//  - Returns null for any path outside /api/v3 (app.ts owns those).
//  - Every reply is JSON with `Content-Type: application/json; charset=utf-8`
//    and a non-empty `X-GitHub-Request-Id` header.
//  - Every known route requires isAuthed(ctx) (else 401); unknown /api/v3
//    routes are 404 {"message":"Not Found"}.
//  - Malformed JSON bodies are 400 {"message": ...}.
//  - List endpoints honour page/per_page and emit a Link header (absolute
//    same-origin URLs) when there is more than one page.
//
// Code is written against the store.ts API in ~/workspace/makefun/notes/STORE.md.
// Only runtime values imported from store.ts are isAuthed, reqId, VIEWER and
// NOW_ISO; the request/response shapes are defined locally so this module does
// not depend on where the coordinator puts the shared Handler types.

import {
  isAuthed,
  reqId,
  VIEWER,
  NOW_ISO,
  type Store,
  type Repo,
  type Issue,
  type IssueComment,
  type PullRequest,
} from './store.ts';

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

const JSON_TYPE = 'application/json; charset=utf-8';

/** One JSON reply: always JSON content type + a non-empty request id. */
function json(store: Store, status: number, body: unknown, extraHeaders: Record<string, string> = {}): Resp {
  return {
    status,
    headers: { 'Content-Type': JSON_TYPE, 'X-GitHub-Request-Id': reqId(store), ...extraHeaders },
    body: body as object,
  };
}

/** An error reply: {"message": "<non-empty>"}. */
function fail(store: Store, status: number, message: string): Resp {
  return json(store, status, { message: message === '' ? 'Error' : message });
}

function decodeSeg(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function originOf(req: Req): string {
  const host = req.headers['host'] ?? req.headers['Host'] ?? 'entry';
  if (host.startsWith('http://') || host.startsWith('https://')) return host.replace(/\/+$/, '');
  return `http://${host}`;
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const rawPer = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const perPage = Number.isFinite(rawPer) && rawPer >= 1 ? Math.min(100, Math.floor(rawPer)) : 30;
  return { page, perPage };
}

/** Slice one page out of a list. */
function paginate<T>(items: readonly T[], query: URLSearchParams): { items: T[]; total: number; page: number; perPage: number } {
  const { page, perPage } = parsePage(query);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), total: items.length, page, perPage };
}

/** GitHub-style Link header; null when everything fits on one page. */
function pageLinks(origin: string, path: string, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const url = (p: number): string => `${origin}${path}?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${url(page - 1)}>; rel="prev"`);
  parts.push(`<${url(1)}>; rel="first"`);
  parts.push(`<${url(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

/** Parse a request body as a JSON object; empty body is {}. */
function parseBody(req: Req): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (req.body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(req.body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: true, value: {} };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// -------------------------------------------------------------------------------------------
// Serializers (extra fields are harmless: the checks assert shapes, not exact keys)

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER.login ? VIEWER.id : 1002,
    name: login === VIEWER.login ? VIEWER.name : login,
    email: login === VIEWER.login ? VIEWER.email : `${login}@example.invalid`,
    type: 'User',
    site_admin: false,
    avatar_url: '',
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName(),
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    fork: false,
    visibility: repo.private ? 'private' : 'public',
    language: null,
    topics: [] as string[],
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: '' };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: issue.userLogin, id: VIEWER.id, type: 'User' },
    assignee: null,
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

function commentJson(comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.userLogin, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function pullJson(pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${VIEWER.login}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${VIEWER.login}:${pr.baseRef}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    user: { login: pr.userLogin, id: VIEWER.id, type: 'User' },
    draft: false,
  };
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

// -------------------------------------------------------------------------------------------

export async function handleRest(store: Store, ctx: Ctx, req: Req): Promise<Resp | null> {
  const path = req.path;
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return null;

  const segments = path
    .split('/')
    .filter((part) => part !== '')
    .slice(2)
    .map(decodeSeg);
  const method = req.method.toUpperCase();
  const origin = originOf(req);

  // Route table: [method, matcher]. A match is a known route (auth applies);
  // anything else under /api/v3 is an unknown route -> 404, whatever the token.
  const route = matchRoute(method, segments);
  if (route === null) return fail(store, 404, 'Not Found');
  if (!isAuthed(ctx)) return fail(store, 401, 'Requires authentication');

  // Bodies are only parsed for methods that carry one.
  let body: Record<string, unknown> = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const parsed = parseBody(req);
    if (!parsed.ok) return fail(store, 400, 'Invalid JSON body');
    body = parsed.value;
  }

  switch (route) {
    case 'root':
      return json(
        store,
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'X-Oauth-Scopes': 'repo, read:org' },
      );
    case 'meta':
      return json(store, 200, { installed_version: '1.0.0' });
    case 'rate-limit':
      return json(store, 200, {
        resources: { core: { limit: 5000, remaining: 5000, reset: 0 } },
        rate: { limit: 5000, remaining: 5000, reset: 0 },
      });
    case 'user':
      return json(store, 200, userJson(VIEWER.login));
    case 'user-repos-create':
      return createRepo(store, body);
    case 'user-repos-list':
      return listRepos(store, req, origin);
    default:
      break;
  }

  // Every remaining route is under /repos/{owner}/{repo}[/...].
  const owner = segments[1] ?? '';
  const repoName = segments[2] ?? '';
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return fail(store, 404, 'Not Found');
  const rest = segments.slice(3);

  switch (route) {
    case 'repo-get':
      return json(store, 200, repoJson(repo));
    case 'repo-patch': {
      if (typeof body.description === 'string') repo.description = body.description;
      repo.updatedAt = NOW_ISO;
      return json(store, 200, repoJson(repo));
    }
    case 'repo-delete': {
      store.reposByName.delete(repo.name);
      return {
        status: 204,
        headers: { 'Content-Type': JSON_TYPE, 'X-GitHub-Request-Id': reqId(store) },
        body: '',
      };
    }
    case 'refs-create':
      return createRef(store, repo, body);
    case 'ref-get':
      return getRef(store, repo, rest);
    case 'branches-list':
      return json(
        store,
        200,
        [...repo.refs.entries()]
          .filter(([name]) => name.startsWith('refs/heads/'))
          .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, sha })),
      );
    case 'branch-get': {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return fail(store, 404, 'Not Found');
      return json(store, 200, { name: branch, commit: { sha }, sha });
    }
    case 'commits-list': {
      const ref = req.query.get('sha') ?? repo.defaultBranch;
      if (store.resolveRef(repo, ref) === undefined) return fail(store, 404, 'Not Found');
      return json(
        store,
        200,
        store.listCommits(repo, ref).map((entry) => ({
          sha: entry.sha,
          commit: { message: entry.message },
        })),
      );
    }
    case 'contents-put':
      return putContent(store, repo, rest.slice(1).join('/'), body);
    case 'contents-get':
      return getContent(store, repo, rest.slice(1).join('/'), req);
    case 'contents-delete':
      return deleteContent(store, repo, rest.slice(1).join('/'), body);
    case 'labels-create': {
      const name = asString(body.name).trim();
      if (name === '') return fail(store, 422, 'Label name is required');
      const color = asString(body.color, 'ededed');
      repo.labels.set(name, { name, color });
      return json(store, 201, { name, color, description: '' });
    }
    case 'labels-list':
      return json(
        store,
        200,
        [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })),
      );
    case 'issues-create':
      return createIssue(store, repo, body);
    case 'issues-list':
      return listIssues(store, repo, req, origin);
    case 'issue-get': {
      const issue = findIssue(repo, rest[1]);
      if (issue === undefined) return fail(store, 404, 'Not Found');
      return json(store, 200, issueJson(repo, issue));
    }
    case 'issue-patch': {
      const issue = findIssue(repo, rest[1]);
      if (issue === undefined) return fail(store, 404, 'Not Found');
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.updatedAt = NOW_ISO;
      return json(store, 200, issueJson(repo, issue));
    }
    case 'issue-comments-create': {
      const issue = findIssue(repo, rest[1]);
      if (issue === undefined) return fail(store, 404, 'Not Found');
      const text = asString(body.body);
      const comment: IssueComment = {
        id: repo.nextCommentId,
        body: text,
        userLogin: VIEWER.login,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      issue.updatedAt = NOW_ISO;
      return json(store, 201, commentJson(comment));
    }
    case 'issue-comments-list': {
      const issue = findIssue(repo, rest[1]);
      if (issue === undefined) return fail(store, 404, 'Not Found');
      return json(store, 200, issue.comments.map((comment) => commentJson(comment)));
    }
    case 'pulls-create':
      return createPull(store, repo, body);
    case 'pulls-list':
      return listPulls(store, repo, req, origin);
    case 'pull-get': {
      const pr = findPull(repo, rest[1]);
      if (pr === undefined) return fail(store, 404, 'Not Found');
      return json(store, 200, pullJson(pr));
    }
    case 'pull-files': {
      const pr = findPull(repo, rest[1]);
      if (pr === undefined) return fail(store, 404, 'Not Found');
      return json(store, 200, store.changedFiles(repo, pr.baseRef, pr.headRef));
    }
    case 'pull-merge':
      return mergePull(store, repo, rest[1]);
    case 'pull-reviews': {
      const pr = findPull(repo, rest[1]);
      if (pr === undefined) return fail(store, 404, 'Not Found');
      return json(store, 200, []);
    }
    default:
      return fail(store, 404, 'Not Found');
  }
}

type Route =
  | 'root'
  | 'meta'
  | 'rate-limit'
  | 'user'
  | 'user-repos-create'
  | 'user-repos-list'
  | 'repo-get'
  | 'repo-patch'
  | 'repo-delete'
  | 'refs-create'
  | 'ref-get'
  | 'branches-list'
  | 'branch-get'
  | 'commits-list'
  | 'contents-put'
  | 'contents-get'
  | 'contents-delete'
  | 'labels-create'
  | 'labels-list'
  | 'issues-create'
  | 'issues-list'
  | 'issue-get'
  | 'issue-patch'
  | 'issue-comments-create'
  | 'issue-comments-list'
  | 'pulls-create'
  | 'pulls-list'
  | 'pull-get'
  | 'pull-files'
  | 'pull-merge'
  | 'pull-reviews';

/** Match method + path segments to a route; null = unknown route. */
function matchRoute(method: string, s: string[]): Route | null {
  if (s.length === 0) return method === 'GET' ? 'root' : null;
  if (s[0] === 'meta') return s.length === 1 && method === 'GET' ? 'meta' : null;
  if (s[0] === 'rate_limit') return s.length === 1 && method === 'GET' ? 'rate-limit' : null;
  if (s[0] === 'user' && s.length === 1) return method === 'GET' ? 'user' : null;
  if (s[0] === 'user' && s[1] === 'repos' && s.length === 2) {
    if (method === 'POST') return 'user-repos-create';
    if (method === 'GET') return 'user-repos-list';
    return null;
  }
  if (s[0] !== 'repos' || s.length < 3) return null;
  // /repos/{owner}/{repo}
  if (s.length === 3) {
    if (method === 'GET') return 'repo-get';
    if (method === 'PATCH') return 'repo-patch';
    if (method === 'DELETE') return 'repo-delete';
    return null;
  }
  const tail = s.slice(3);
  if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2) {
    return method === 'POST' ? 'refs-create' : null;
  }
  if (tail[0] === 'git' && tail[1] === 'refs' && tail.length > 2) {
    return method === 'GET' ? 'ref-get' : null;
  }
  if (tail[0] === 'branches' && tail.length === 1) return method === 'GET' ? 'branches-list' : null;
  if (tail[0] === 'branches' && tail.length > 1) return method === 'GET' ? 'branch-get' : null;
  if (tail[0] === 'commits' && tail.length === 1) return method === 'GET' ? 'commits-list' : null;
  if (tail[0] === 'contents') {
    if (method === 'PUT') return 'contents-put';
    if (method === 'GET') return 'contents-get';
    if (method === 'DELETE') return 'contents-delete';
    return null;
  }
  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'POST') return 'labels-create';
    if (method === 'GET') return 'labels-list';
    return null;
  }
  if (tail[0] === 'issues' && tail.length === 1) {
    if (method === 'POST') return 'issues-create';
    if (method === 'GET') return 'issues-list';
    return null;
  }
  if (tail[0] === 'issues' && tail.length === 2) {
    if (method === 'GET') return 'issue-get';
    if (method === 'PATCH') return 'issue-patch';
    return null;
  }
  if (tail[0] === 'issues' && tail[1] !== undefined && tail[2] === 'comments' && tail.length === 3) {
    if (method === 'POST') return 'issue-comments-create';
    if (method === 'GET') return 'issue-comments-list';
    return null;
  }
  if (tail[0] === 'pulls' && tail.length === 1) {
    if (method === 'POST') return 'pulls-create';
    if (method === 'GET') return 'pulls-list';
    return null;
  }
  if (tail[0] === 'pulls' && tail.length === 2) {
    return method === 'GET' ? 'pull-get' : null;
  }
  if (tail[0] === 'pulls' && tail.length === 3 && tail[2] === 'files') {
    return method === 'GET' ? 'pull-files' : null;
  }
  if (tail[0] === 'pulls' && tail.length === 3 && tail[2] === 'merge') {
    return method === 'PUT' ? 'pull-merge' : null;
  }
  if (tail[0] === 'pulls' && tail.length === 3 && tail[2] === 'reviews') {
    return method === 'GET' ? 'pull-reviews' : null;
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// Repositories

function createRepo(store: Store, body: Record<string, unknown>): Resp {
  const name = asString(body.name).trim();
  if (name === '') return fail(store, 422, 'Repository name is required');
  const repo = store.createRepo(name, asString(body.description), body.private === true);
  if (repo === null) return fail(store, 422, `Repository ${name} already exists`);
  return json(store, 201, repoJson(repo));
}

function listRepos(store: Store, req: Req, origin: string): Resp {
  const { items, total, page, perPage } = paginate(store.listRepos(), req.query);
  const headers: Record<string, string> = {};
  const links = pageLinks(origin, req.path, page, perPage, total);
  if (links !== null) headers['Link'] = links;
  return json(store, 200, items.map((repo) => repoJson(repo)), headers);
}

// -------------------------------------------------------------------------------------------
// Git refs / branches / commits / contents

function createRef(store: Store, repo: Repo, body: Record<string, unknown>): Resp {
  const ref = asString(body.ref);
  const sha = asString(body.sha);
  if (!ref.startsWith('refs/heads/') || ref === 'refs/heads/' || sha === '') {
    return fail(store, 422, 'Invalid ref: expected {ref: "refs/heads/<branch>", sha: "<commit>"}');
  }
  repo.refs.set(ref, sha);
  return json(store, 201, { ref, object: { sha }, sha });
}

function getRef(store: Store, repo: Repo, rest: string[]): Resp {
  // rest: ['git', 'refs', ...] — the remainder is the ref name after 'refs/'.
  const ref = `refs/${rest.slice(2).join('/')}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) return fail(store, 404, 'Not Found');
  return json(store, 200, { ref, object: { sha }, sha });
}

function putContent(store: Store, repo: Repo, path: string, body: Record<string, unknown>): Resp {
  if (path === '') return fail(store, 422, 'File path is required');
  if (typeof body.content !== 'string') return fail(store, 422, 'content is required');
  const content = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
  const message = asString(body.message);
  const branch = asString(body.branch, repo.defaultBranch) === '' ? repo.defaultBranch : asString(body.branch, repo.defaultBranch);
  const existing = store.readFileAt(repo, branch, path);
  if (existing !== undefined) {
    const givenSha = asString(body.sha);
    if (givenSha !== '' && givenSha.toLowerCase() !== existing.sha.toLowerCase()) {
      return fail(store, 409, 'sha does not match the current file version');
    }
    const result = store.commitFile(repo, branch, path, content, message);
    return json(store, 200, contentCommitJson(path, content, result));
  }
  const result = store.commitFile(repo, branch, path, content, message);
  return json(store, 201, contentCommitJson(path, content, result));
}

function contentCommitJson(
  path: string,
  content: Buffer,
  result: { commitSha: string; blobSha: string },
): Record<string, unknown> {
  return {
    content: {
      name: baseName(path),
      path,
      sha: result.blobSha,
      size: content.length,
      type: 'file',
      encoding: 'base64',
    },
    commit: { sha: result.commitSha },
  };
}

function getContent(store: Store, repo: Repo, path: string, req: Req): Resp {
  const ref = req.query.get('ref') ?? repo.defaultBranch;
  const file = store.readFileAt(repo, ref, path);
  if (file !== undefined) {
    return json(store, 200, {
      type: 'file',
      encoding: 'base64',
      content: file.blob.toString('base64'),
      sha: file.sha,
      size: file.blob.length,
      name: baseName(path),
      path,
    });
  }
  const dir = store.listDirAt(repo, ref, path);
  if (dir !== undefined) return json(store, 200, dir);
  return fail(store, 404, 'Not Found');
}

function deleteContent(store: Store, repo: Repo, path: string, body: Record<string, unknown>): Resp {
  if (path === '') return fail(store, 422, 'File path is required');
  const branch = asString(body.branch, repo.defaultBranch) === '' ? repo.defaultBranch : asString(body.branch, repo.defaultBranch);
  const result = store.deleteFile(repo, branch, path, asString(body.message));
  if ('error' in result) return fail(store, 404, 'Not Found');
  return json(store, 200, { commit: { sha: result.commitSha } });
}

// -------------------------------------------------------------------------------------------
// Issues

function findIssue(repo: Repo, raw: string | undefined): Issue | undefined {
  const number = Number(raw);
  if (!Number.isInteger(number)) return undefined;
  return repo.issues.find((issue) => issue.number === number);
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item !== '') names.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string') {
      names.push((item as Record<string, unknown>).name as string);
    }
  }
  return names;
}

function createIssue(store: Store, repo: Repo, body: Record<string, unknown>): Resp {
  const result = store.createIssue(repo, asString(body.title), asString(body.body), labelNames(body.labels));
  if ('error' in result) {
    return fail(store, 422, `Label '${(result as { label: string }).label}' does not exist`);
  }
  return json(store, 201, issueJson(repo, result as Issue));
}

function listIssues(store: Store, repo: Repo, req: Req, origin: string): Resp {
  const state = req.query.get('state') ?? 'open';
  let items = [...repo.issues];
  if (state === 'open') items = items.filter((issue) => issue.state === 'open');
  else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
  // state=all (or anything else unrecognised) lists everything.
  const sort = req.query.get('sort') ?? 'created';
  const direction = req.query.get('direction') ?? 'desc';
  if (sort === 'created' && direction === 'desc') items = [...items].reverse();
  const { items: page, total, page: pageNo, perPage } = paginate(items, req.query);
  const headers: Record<string, string> = {};
  const links = pageLinks(origin, req.path, pageNo, perPage, total);
  if (links !== null) headers['Link'] = links;
  return json(store, 200, page.map((issue) => issueJson(repo, issue)), headers);
}

// -------------------------------------------------------------------------------------------
// Pull requests

function findPull(repo: Repo, raw: string | undefined): PullRequest | undefined {
  const number = Number(raw);
  if (!Number.isInteger(number)) return undefined;
  return repo.pulls.find((pr) => pr.number === number);
}

function refName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).ref === 'string') {
    return (value as Record<string, unknown>).ref as string;
  }
  return '';
}

function createPull(store: Store, repo: Repo, body: Record<string, unknown>): Resp {
  const head = refName(body.head);
  const base = refName(body.base);
  if (head === '' || base === '') return fail(store, 422, 'head and base branches are required');
  const result = store.createPull(repo, asString(body.title), asString(body.body), head, base);
  if ('error' in result) {
    const message = asString((result as { error: string }).error, 'Invalid head or base branch');
    return fail(store, 422, message === '' ? 'Invalid head or base branch' : message);
  }
  return json(store, 201, pullJson(result as PullRequest));
}

function listPulls(store: Store, repo: Repo, req: Req, origin: string): Resp {
  const state = req.query.get('state');
  let items = [...repo.pulls];
  if (state === 'all') {
    // everything
  } else if (state === 'closed') {
    items = items.filter((pr) => pr.state === 'closed');
  } else {
    items = items.filter((pr) => pr.state === 'open');
  }
  const { items: page, total, page: pageNo, perPage } = paginate(items, req.query);
  const headers: Record<string, string> = {};
  const links = pageLinks(origin, req.path, pageNo, perPage, total);
  if (links !== null) headers['Link'] = links;
  return json(store, 200, page.map((pr) => pullJson(pr)), headers);
}

function mergePull(store: Store, repo: Repo, raw: string | undefined): Resp {
  const pr = findPull(repo, raw);
  if (pr === undefined) return fail(store, 404, 'Not Found');
  if (pr.merged) return fail(store, 405, 'Pull request is already merged');
  if (!store.isMergeable(repo, pr)) return fail(store, 405, 'Merge conflict: head and base both changed the same file');
  const result = store.mergePull(repo, pr.number, 'squash');
  if ('error' in result) {
    if (result.error === 'not-found') return fail(store, 404, 'Not Found');
    return fail(store, 405, 'Merge conflict');
  }
  return json(store, 200, {
    merged: true,
    sha: result.sha,
    message: `Pull request #${pr.number} merged`,
  });
}
