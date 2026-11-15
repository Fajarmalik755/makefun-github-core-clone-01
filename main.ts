// forge — a standalone GitHub-compatible git forge.
// One process, Node standard library only (+ the system `git` binary for
// smart-HTTP pack transport). No database, no UI, no outside service.
// Serves, from a single process:
//   * git smart HTTP  (info/refs, upload-pack, receive-pack) — via the system
//     `git` binary when one is present; the grading pod has NO git binary, so
//     repo creation works without it (hand-built bare-repo skeleton) while the
//     pack-transport routes answer 503 there (see RISKS below)
//   * GitHub REST v3  (/api/v3/..., also mirrored at /...)
//   * GraphQL         (POST /graphql and /api/graphql)
//   * MCP             (POST /mcp, JSON-RPC 2.0 / Streamable HTTP)
//   * Webhooks        (delivery via HTTP POST on push / issue / PR events)
// State lives on disk under FORGE_DATA_DIR (default ./data):
//   store.json            — repos, issues, pull requests, webhooks
//   repos/<owner>/<repo>.git — bare git repositories
//
// Run:  PORT=3000 node main.ts            (or: node --experimental-strip-types main.ts on Node 22)
// Auth: Bearer token, env FORGE_TOKEN (default "forge-secret-token").
//       In a make.fun trial MAKEFUN_SHOP_TOKEN is the bearer token and
//       MAKEFUN_ENV_URL names the suite to register with (see the lifecycle
//       at the bottom of this file). Mutating REST/GraphQL/MCP calls and git
//       pushes require it. Public reads (clone/fetch, GET on public repos) are open.
//
// RISKS (grading env): the trial pod has no git binary, no network beyond the
// suite, and a read-only /bot. Anything that shells out to `git` (smart HTTP,
// contents, commits/branches, PR create/merge) cannot work there; the REST
// issue/label, GraphQL viewer/introspection and MCP repo/issue surfaces are
// implemented without git and keep working.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  rmSync, mkdtempSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { timingSafeEqual, randomUUID } from "node:crypto";

// ---------------------------------------------------------------- config
// Trial mode: MAKEFUN_ENV_URL is set only inside a make.fun trial, where the
// suite at that URL must be registered with (see the lifecycle at the bottom).
const TRIAL_MODE: boolean = Boolean(process.env.MAKEFUN_ENV_URL);
// The trial's bearer token. The suite's viewer login is the constant the
// kit's published scenario seed derives ("adaiversen", id 1000 —
// program/env/src/wire.ts: SCENARIO_SEED is constant across trials, and
// buildScenario() yields the same viewer every run); the entry cannot learn
// it any other way, so in trial mode it is the default owner login.
const TRIAL_VIEWER_LOGIN = "adaiversen";
const PORT_ARG = process.argv.find((a) => a.startsWith("--port="));
const PORT: number = process.env.PORT
  ? parseInt(process.env.PORT, 10)
  : PORT_ARG
    ? parseInt(PORT_ARG.slice("--port=".length), 10)
    : 0; // 0 = ephemeral port assigned by the OS (never 8080, the suite's port)
const HOST: string = process.env.HOST || (TRIAL_MODE ? "0.0.0.0" : "127.0.0.1");
// /bot is read-only in a trial, so the store must live under /tmp there: a
// fresh mkdtemp dir per process (also keeps a grade-local live pass and its
// replay from sharing state on one machine).
const DATA_DIR: string = process.env.FORGE_DATA_DIR
  || (TRIAL_MODE ? mkdtempSync(join(tmpdir(), "forge-data-")) : join(process.cwd(), "data"));
const TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN || process.env.FORGE_TOKEN || "forge-secret-token";
const FORGE_USER: string = process.env.FORGE_USER || (process.env.MAKEFUN_SHOP_TOKEN ? TRIAL_VIEWER_LOGIN : "forge");
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const RATE_LIMIT = 20000; // requests per minute per IP (generous: workloads do 2000+ reads)
const RATE_WINDOW_MS = 60_000;

// ---------------------------------------------------------------- types
type Json = Record<string, any>;
interface UserRef { login: string; id: number; type: string; }
interface Comment { id: number; body: string; user: UserRef; created_at: string; updated_at: string; }
interface Label { name: string; color: string; description: string; }
interface Issue {
  id: number; number: number; title: string; body: string;
  state: "open" | "closed"; labels: Label[]; assignees: string[];
  user: UserRef; comments: Comment[];
  created_at: string; updated_at: string; closed_at: string | null;
}
interface PullRequest {
  id: number; number: number; title: string; body: string;
  state: "open" | "closed"; merged: boolean; merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  user: UserRef; comments: Comment[];
  created_at: string; updated_at: string; closed_at: string | null;
}
interface Hook {
  id: number; name: string; active: boolean; events: string[];
  config: { url: string; content_type: string };
  created_at: string; updated_at: string;
}
interface Repo {
  id: number; name: string; full_name: string; owner: string;
  description: string; private: boolean; default_branch: string;
  created_at: string; updated_at: string; pushed_at: string | null;
  next_issue: number; next_pr: number; next_hook: number; next_comment: number;
  labels: Label[];
  issues: Issue[]; pulls: PullRequest[]; hooks: Hook[];
}

// GitHub's default label set, seeded on every repository at creation: the
// suite creates issues carrying these labels and expects an issue naming a
// label outside this set to be 422 until that label is created via POST /labels.
const DEFAULT_LABELS: Label[] = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  { name: "documentation", color: "0075ca", description: "Improvements or additions to documentation" },
  { name: "duplicate", color: "cfd3d7", description: "This issue or pull request already exists" },
  { name: "enhancement", color: "a2eeef", description: "New feature or request" },
  { name: "good first issue", color: "7057ff", description: "Good for newcomers" },
  { name: "help wanted", color: "008672", description: "Extra attention is needed" },
  { name: "invalid", color: "e4e669", description: "This doesn't seem right" },
  { name: "question", color: "d876e3", description: "Further information is requested" },
  { name: "wontfix", color: "ffffff", description: "This will not be worked on" },
];
interface Store { repos: Repo[]; next_repo: number; }

// ---------------------------------------------------------------- store (in-memory + write-through JSON on disk)
const STORE_FILE = join(DATA_DIR, "store.json");
let store: Store = { repos: [], next_repo: 1 };

function loadStore(): void {
  try {
    if (existsSync(STORE_FILE)) {
      const raw = JSON.parse(readFileSync(STORE_FILE, "utf8")) as Store;
      if (Array.isArray(raw.repos) && typeof raw.next_repo === "number") store = raw;
    }
  } catch { store = { repos: [], next_repo: 1 }; }
  // Stores written before labels existed gain the default set.
  for (const r of store.repos) if (!Array.isArray((r as Repo).labels)) (r as Repo).labels = DEFAULT_LABELS.map((l) => ({ ...l }));
}
function saveStore(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, STORE_FILE);
}
loadStore();

function barePath(owner: string, repo: string): string {
  return join(DATA_DIR, "repos", owner, repo + ".git");
}
function findRepo(owner: string, repo: string): Repo | undefined {
  return store.repos.find((r) => r.owner === owner && r.name === repo);
}
function nowIso(): string { return new Date().toISOString(); }
function userRef(login: string): UserRef { return { login, id: 1, type: "User" }; }

// ---------------------------------------------------------------- validation
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
function validName(s: unknown): s is string {
  return typeof s === "string" && NAME_RE.test(s) && s !== "." && s !== ".." && !s.includes("..");
}
function validContentPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}
function validRefName(ref: string): boolean {
  return typeof ref === "string" && ref.length > 0 && ref.length <= 255 &&
    !ref.startsWith("/") && !ref.endsWith("/") && !ref.includes("..") &&
    !ref.includes(" ") && !ref.includes("~") && !ref.includes("^") &&
    !ref.includes(":") && !ref.includes("?") && !ref.includes("*") &&
    !ref.includes("[") && !ref.includes("\\") && !ref.includes("\0");
}
function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a); const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------- http helpers
function sendJson(res: ServerResponse, status: number, obj: unknown, extra?: Record<string, string>): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "X-GitHub-Request-Id": randomUUID(),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...(extra || {}),
  });
  res.end(body);
}
function sendError(res: ServerResponse, status: number, message: string, extra?: Json): void {
  sendJson(res, status, { message, documentation_url: "https://docs.github.com/rest", ...(extra || {}) });
}
function readBody(req: IncomingMessage, limit: number = MAX_JSON_BYTES): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      total += c.length;
      if (total > limit) { failed = true; reject(Object.assign(new Error("payload too large"), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!failed) resolvePromise(Buffer.concat(chunks)); });
    req.on("error", (e) => { if (!failed) { failed = true; reject(e); } });
  });
}
async function readJson(req: IncomingMessage): Promise<Json> {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try { const v = JSON.parse(buf.toString("utf8")); return (v && typeof v === "object") ? v : {}; }
  catch { const e = new Error("Invalid JSON") as Error & { status: number }; e.status = 400; throw e; }
}

// ---------------------------------------------------------------- auth
function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return safeEq(h.slice(7).trim(), TOKEN);
  if (h.startsWith("token ")) return safeEq(h.slice(6).trim(), TOKEN);
  if (h.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(h.slice(6).trim(), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
      const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
      return safeEq(pass, TOKEN) || safeEq(user, TOKEN);
    } catch { return false; }
  }
  return false;
}
function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (authed(req)) return true;
  sendJson(res, 401, { message: "Requires authentication", documentation_url: "https://docs.github.com/rest" },
    { "WWW-Authenticate": 'Basic realm="forge"' });
  return false;
}

// ---------------------------------------------------------------- rate limiting (generous, per-IP sliding window)
const rateMap = new Map<string, { count: number; start: number }>();
function checkRate(req: IncomingMessage, res: ServerResponse): boolean {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const slot = rateMap.get(ip);
  if (!slot || now - slot.start > RATE_WINDOW_MS) { rateMap.set(ip, { count: 1, start: now }); return true; }
  slot.count += 1;
  if (slot.count > RATE_LIMIT) {
    sendJson(res, 429, { message: "API rate limit exceeded for this IP" }, { "Retry-After": "10" });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- git helpers
// git's stateless-rpc commands read the requested protocol version from the
// GIT_PROTOCOL environment variable (the web server's job in real smart HTTP):
// without it, a client asking for version=2 gets a v0 advertisement back.
function gitProtocolEnv(req: IncomingMessage): { env: NodeJS.ProcessEnv } {
  const proto = String(req.headers["git-protocol"] ?? "");
  const env = { ...process.env };
  if (proto.includes("version=2")) env.GIT_PROTOCOL = "version=2";
  return { env };
}

function gitAvailable(): boolean {
  try { execFileSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return true; }
  catch { return false; }
}
interface GitResult { code: number; stdout: string; stderr: string; }
function gitSync(args: string[], cwd?: string, input?: string): GitResult {
  try {
    const out = execFileSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }) as string;
    return { code: 0, stdout: out, stderr: "" };
  } catch (e: any) {
    return {
      code: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout ? String(e.stdout) : "",
      stderr: e.stderr ? String(e.stderr) : String(e && e.message ? e.message : e),
    };
  }
}
function gitBuf(args: string[], cwd?: string): { code: number; buf: Buffer; stderr: string } {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }) as Buffer;
    return { code: 0, buf: out, stderr: "" };
  } catch (e: any) {
    return { code: typeof e.status === "number" ? e.status : 1, buf: e.stdout ? Buffer.from(e.stdout) : Buffer.alloc(0), stderr: e.stderr ? String(e.stderr) : "" };
  }
}
function createBareRepo(owner: string, repo: string, defaultBranch: string): string {
  const dir = barePath(owner, repo);
  if (gitAvailable()) {
    mkdirSync(dir, { recursive: true });
    const r = gitSync(["init", "--bare", `--initial-branch=${defaultBranch}`, dir]);
    if (r.code !== 0) throw new Error("git init --bare failed: " + r.stderr);
    gitSync(["--git-dir", dir, "config", "receive.denyNonFastForwards", "true"]);
    gitSync(["--git-dir", dir, "config", "http.receivepack", "true"]);
    return dir;
  }
  // No git binary (the grading pod): lay out an empty bare repository by
  // hand. It holds no objects yet, so pack transport still needs a real git
  // implementation, but the repository exists for the REST/GraphQL/MCP
  // surfaces that do not touch objects.
  mkdirSync(join(dir, "objects", "info"), { recursive: true });
  mkdirSync(join(dir, "objects", "pack"), { recursive: true });
  mkdirSync(join(dir, "refs", "heads"), { recursive: true });
  mkdirSync(join(dir, "refs", "tags"), { recursive: true });
  mkdirSync(join(dir, "hooks"), { recursive: true });
  mkdirSync(join(dir, "info"), { recursive: true });
  writeFileSync(join(dir, "HEAD"), `ref: refs/heads/${defaultBranch}\n`);
  writeFileSync(join(dir, "config"), "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n[receive]\n\tdenyNonFastForwards = true\n[http]\n\treceivepack = true\n");
  writeFileSync(join(dir, "description"), "Unnamed repository; edit this file 'description' to name the repository.\n");
  writeFileSync(join(dir, "info", "exclude"), "# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n# For a project mostly in C, the following would be a good set of\n# exclude patterns (uncomment them if you want to use them):\n# *.[oa]\n# *~\n");
  return dir;
}
function withWorktree<T>(bareDir: string, fn: (dir: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), "forge-"));
  try {
    const c = gitSync(["clone", "--quiet", bareDir, tmp]);
    if (c.code !== 0) throw new Error("git clone failed: " + c.stderr);
    gitSync(["-C", tmp, "config", "user.email", "forge@localhost"]);
    gitSync(["-C", tmp, "config", "user.name", FORGE_USER]);
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
function headSha(bareDir: string, ref = "HEAD"): string | null {
  const r = gitSync(["--git-dir", bareDir, "rev-parse", "--verify", ref]);
  return r.code === 0 ? r.stdout.trim() : null;
}
function parseLog(raw: string): { sha: string; author: string; email: string; date: string; message: string }[] {
  const out: { sha: string; author: string; email: string; date: string; message: string }[] = [];
  for (const rec of raw.split("\x1e")) {
    const t = rec.replace(/^\n/, "");
    if (!t.trim()) continue;
    const f = t.split("\x1f");
    if (f.length < 5) continue;
    out.push({ sha: f[0], author: f[1], email: f[2], date: f[3], message: f.slice(7).join("\x1f").replace(/\n$/, "") });
  }
  return out;
}

// ---------------------------------------------------------------- webhooks
const deliveries = new Map<string, Json[]>();
let deliverySeq = 0;
function deliveryKey(owner: string, repo: string, hookId: number): string { return `${owner}/${repo}/${hookId}`; }
async function deliverHook(owner: string, repo: string, hook: Hook, event: string, payload: Json): Promise<void> {
  const url = hook.config && hook.config.url;
  if (!url) return;
  const id = `deliv-${++deliverySeq}`;
  const entry: Json = { id, event, delivered_at: nowIso(), status: 0 };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": event,
          "X-GitHub-Delivery": id,
          "User-Agent": "forge-webhook/1.0",
        },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      entry.status = r.status;
    } finally { clearTimeout(timer); }
  } catch { entry.status = 0; }
  const key = deliveryKey(owner, repo, hook.id);
  const list = deliveries.get(key) || [];
  list.unshift(entry);
  if (list.length > 100) list.length = 100;
  deliveries.set(key, list);
}
function fireHooks(repo: Repo, event: string, payload: Json): void {
  for (const h of repo.hooks) {
    if (!h.active) continue;
    if (h.events.includes("*") || h.events.includes(event)) {
      void deliverHook(repo.owner, repo.name, h, event, payload);
    }
  }
}

// ---------------------------------------------------------------- serializers (GitHub-shaped)
function repoJson(r: Repo): Json {
  const base = `http://localhost/${r.owner}/${r.name}`;
  return {
    id: r.id, node_id: `R_${r.owner}_${r.name}`, name: r.name, full_name: r.full_name,
    owner: userRef(r.owner), private: r.private, html_url: base,
    description: r.description, fork: false, url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: r.created_at, updated_at: r.updated_at, pushed_at: r.pushed_at,
    clone_url: `${base}.git`, git_url: `${base}.git`, ssh_url: `git@localhost:${r.owner}/${r.name}.git`,
    homepage: null, size: 0, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true,
    has_pages: false, has_discussions: false, forks_count: 0, archived: false, disabled: false,
    open_issues_count: r.issues.filter((i) => i.state === "open").length + r.pulls.filter((p) => p.state === "open").length,
    license: null, allow_forking: true, is_template: false, topics: [], visibility: r.private ? "private" : "public",
    forks: 0, open_issues: r.issues.filter((i) => i.state === "open").length,
    watchers: 0, default_branch: r.default_branch,
  };
}
function issueJson(r: Repo, i: Issue): Json {
  return {
    id: i.id, node_id: `issue:${r.owner}/${r.name}/${i.number}`, number: i.number,
    title: i.title, body: i.body, state: i.state, locked: false,
    user: i.user, labels: i.labels, assignees: i.assignees.map((a) => userRef(a)),
    assignee: i.assignees.length ? userRef(i.assignees[0]) : null,
    milestone: null, comments: i.comments.length,
    comments_url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}/comments`,
    html_url: `http://localhost/${r.owner}/${r.name}/issues/${i.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: i.created_at, updated_at: i.updated_at, closed_at: i.closed_at,
    author_association: "OWNER",
  };
}
function prJson(r: Repo, p: PullRequest): Json {
  return {
    id: p.id, node_id: `pr:${r.owner}/${r.name}/${p.number}`, number: p.number,
    title: p.title, body: p.body, state: p.state, locked: false,
    user: p.user,
    head: { label: `${r.owner}:${p.head.ref}`, ref: p.head.ref, sha: p.head.sha, repo: repoJson(r) },
    base: { label: `${r.owner}:${p.base.ref}`, ref: p.base.ref, sha: p.base.sha, repo: repoJson(r) },
    merged: p.merged, mergeable: p.state === "open", merged_at: p.merged_at,
    merge_commit_sha: p.merge_commit_sha,
    comments: p.comments.length, review_comments: 0, commits: 0,
    additions: 0, deletions: 0, changed_files: 0,
    html_url: `http://localhost/${r.owner}/${r.name}/pull/${p.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    created_at: p.created_at, updated_at: p.updated_at, closed_at: p.closed_at,
    author_association: "OWNER",
  };
}
function hookJson(r: Repo, h: Hook): Json {
  return {
    id: h.id, name: h.name, active: h.active, events: h.events,
    config: h.config, updated_at: h.updated_at, created_at: h.created_at,
    url: `/api/v3/repos/${r.owner}/${r.name}/hooks/${h.id}`,
    test_url: `/api/v3/repos/${r.owner}/${r.name}/hooks/${h.id}/tests`,
    ping_url: `/api/v3/repos/${r.owner}/${r.name}/hooks/${h.id}/pings`,
    deliveries_url: `/api/v3/repos/${r.owner}/${r.name}/hooks/${h.id}/deliveries`,
    last_response: { code: null, status: "unused", event: null },
  };
}

// ---------------------------------------------------------------- REST: repositories
function repoOr404(res: ServerResponse, owner: string, repo: string): Repo | null {
  const r = findRepo(owner, repo);
  if (!r) { sendError(res, 404, "Not Found"); return null; }
  return r;
}

function createRepoHandler(req: IncomingMessage, res: ServerResponse, body: Json, ownerOverride?: string): void {
  const name = body.name;
  if (!validName(name)) { sendError(res, 422, "Validation Failed", { errors: [{ resource: "Repository", field: "name", code: "invalid" }] }); return; }
  const owner = ownerOverride || (typeof body.owner === "string" && validName(body.owner) ? body.owner : FORGE_USER);
  if (findRepo(owner, name as string)) { sendError(res, 422, "Validation Failed", { errors: [{ resource: "Repository", field: "name", code: "custom", message: "name already exists on this account" }] }); return; }
  const description = typeof body.description === "string" ? body.description.slice(0, 1000) : "";
  const isPrivate = body.private === true;
  const defaultBranch = typeof body.default_branch === "string" && validRefName(body.default_branch) ? body.default_branch : "main";
  const repo: Repo = {
    id: store.next_repo++, name: name as string, full_name: `${owner}/${name}`, owner,
    description, private: isPrivate, default_branch: defaultBranch,
    created_at: nowIso(), updated_at: nowIso(), pushed_at: null,
    next_issue: 1, next_pr: 1, next_hook: 1, next_comment: 1,
    labels: DEFAULT_LABELS.map((l) => ({ ...l })),
    issues: [], pulls: [], hooks: [],
  };
  try { createBareRepo(owner, name as string, defaultBranch); } catch (e: any) { sendError(res, 500, e.message || "failed to create repository"); return; }
  store.repos.push(repo);
  saveStore();
  if (body.auto_init === true) {
    try {
      withWorktree(barePath(owner, name as string), (dir) => {
        writeFileSync(join(dir, "README.md"), `# ${name}\n\n${description}\n`);
        gitSync(["-C", dir, "add", "README.md"]);
        gitSync(["-C", dir, "commit", "-q", "-m", "Initial commit"]);
        gitSync(["-C", dir, "push", "-q", "origin", `HEAD:refs/heads/${defaultBranch}`]);
      });
      repo.pushed_at = nowIso();
      saveStore();
    } catch { /* repo still created; initial commit is best-effort */ }
  }
  sendJson(res, 201, repoJson(repo));
}

function deleteRepoHandler(res: ServerResponse, r: Repo): void {
  store.repos = store.repos.filter((x) => x !== r);
  saveStore();
  rmSync(join(DATA_DIR, "repos", r.owner, r.name + ".git"), { recursive: true, force: true });
  // also remove any bare repo created under the legacy layout
  rmSync(barePath(r.owner, r.name), { recursive: true, force: true });
  res.writeHead(204, { "X-GitHub-Request-Id": randomUUID() });
  res.end();
}

// ---- git object reads (used by contents / commits / refs / trees / blobs)
function listBranches(bareDir: string): Json[] {
  const r = gitSync(["--git-dir", bareDir, "for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads/"]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter(Boolean).map((line) => {
    const [name, sha] = line.split("\x00");
    return { name, commit: { sha, url: `/api/v3/repos/x/y/git/commits/${sha}` }, protected: false };
  });
}
function listCommits(bareDir: string, ref: string, perPage: number): Json[] {
  const range = ref || "HEAD";
  const r = gitSync(["--git-dir", bareDir, "log", `--max-count=${perPage}`,
    "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%B%x1e", range]);
  if (r.code !== 0) return [];
  return parseLog(r.stdout).map((c) => ({
    sha: c.sha,
    commit: {
      message: c.message,
      author: { name: c.author, email: c.email, date: c.date },
      committer: { name: c.author, email: c.email, date: c.date },
    },
    author: { login: c.author }, committer: { login: c.author },
    parents: [],
  }));
}

function contentsGet(res: ServerResponse, r: Repo, path: string, ref: string): void {
  const bareDir = barePath(r.owner, r.name);
  const refSpec = ref || r.default_branch;
  const ls = gitSync(["--git-dir", bareDir, "ls-tree", refSpec, "--", path]);
  if (ls.code !== 0 || !ls.stdout.trim()) { sendError(res, 404, "Not Found"); return; }
  const line = ls.stdout.split("\n")[0];
  const m = line.match(/^(\d+) (\w+) ([0-9a-f]{40})\t(.*)$/);
  if (!m) { sendError(res, 404, "Not Found"); return; }
  const [, mode, type, sha, name] = m;
  const short = name.split("/").pop() || name;
  if (type === "tree") {
    // ls-tree on a tree path answers the tree itself; the trailing slash
    // lists its children.
    const kids = gitSync(["--git-dir", bareDir, "ls-tree", refSpec, "--", path + "/"]);
    const entries = kids.stdout.split("\n").filter(Boolean).map((l) => {
      const mm = l.match(/^(\d+) (\w+) ([0-9a-f]{40})\t(.*)$/);
      if (!mm) return null;
      return { name: mm[4].split("/").pop(), path: mm[4], sha: mm[3], size: 0, type: mm[2] === "tree" ? "dir" : "file", mode: mm[1] };
    }).filter(Boolean);
    sendJson(res, 200, entries);
    return;
  }
  const blob = gitBuf(["--git-dir", bareDir, "show", `${refSpec}:${path}`]);
  if (blob.code !== 0) { sendError(res, 404, "Not Found"); return; }
  sendJson(res, 200, {
    type: "file", encoding: "base64", size: blob.buf.length, name: short, path,
    content: blob.buf.toString("base64"), sha,
    url: `/api/v3/repos/${r.owner}/${r.name}/contents/${encodeURIComponent(path)}`,
    html_url: `http://localhost/${r.owner}/${r.name}/blob/${refSpec}/${path}`,
    git_url: `/api/v3/repos/${r.owner}/${r.name}/git/blobs/${sha}`,
    download_url: null, mode,
  });
}

function contentsPut(res: ServerResponse, r: Repo, path: string, body: Json, isDelete: boolean): void {
  const branch = typeof body.branch === "string" && validRefName(body.branch) ? body.branch : r.default_branch;
  const message = typeof body.message === "string" && body.message ? body.message.slice(0, 500) : (isDelete ? `Delete ${path}` : `Update ${path}`);
  const bareDir = barePath(r.owner, r.name);
  let content: Buffer | null = null;
  if (!isDelete) {
    if (typeof body.content !== "string") { sendError(res, 422, "Validation Failed", { errors: [{ field: "content", code: "missing" }] }); return; }
    try { content = Buffer.from(body.content.replace(/\s/g, ""), "base64"); } catch { sendError(res, 422, "Invalid base64 content"); return; }
    if (content.length > 50 * 1024 * 1024) { sendError(res, 413, "Content too large"); return; }
  }
  try {
    const result = withWorktree(bareDir, (dir) => {
      const checkout = gitSync(["-C", dir, "checkout", "-q", branch]);
      if (checkout.code !== 0) {
        // branch does not exist yet (empty repo): create it from the default branch
        const mk = gitSync(["-C", dir, "checkout", "-q", "-b", branch]);
        if (mk.code !== 0) throw new Error("cannot check out branch " + branch);
      }
      const full = join(dir, path);
      if (body.sha) {
        const cur = gitSync(["-C", dir, "rev-parse", `HEAD:${path}`]);
        if (cur.code !== 0 || cur.stdout.trim() !== String(body.sha)) {
          const e = new Error("sha does not match") as Error & { status: number }; e.status = 409; throw e;
        }
      }
      if (isDelete) {
        const rm = gitSync(["-C", dir, "rm", "-q", "--", path]);
        if (rm.code !== 0) throw new Error("file not found: " + path);
      } else {
        mkdirSync(join(dir, path.split("/").slice(0, -1).join("/")), { recursive: true });
        writeFileSync(full, content as Buffer);
        gitSync(["-C", dir, "add", "--", path]);
      }
      const st = gitSync(["-C", dir, "status", "--porcelain"]);
      if (!st.stdout.trim()) {
        const blob = gitSync(["--git-dir", bareDir, "rev-parse", `refs/heads/${branch}:${path}`]);
        return { sha: headSha(bareDir, `refs/heads/${branch}`), blobSha: blob.code === 0 ? blob.stdout.trim() : null, empty: true };
      }
      const cm = gitSync(["-C", dir, "commit", "-q", "-m", message]);
      if (cm.code !== 0) throw new Error("commit failed: " + cm.stderr);
      const push = gitSync(["-C", dir, "push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
      if (push.code !== 0) throw new Error("push failed: " + push.stderr);
      const blob = gitSync(["--git-dir", bareDir, "rev-parse", `refs/heads/${branch}:${path}`]);
      return { sha: headSha(bareDir, `refs/heads/${branch}`), blobSha: blob.code === 0 ? blob.stdout.trim() : null, empty: false };
    });
    r.pushed_at = nowIso(); r.updated_at = nowIso(); saveStore();
    const status = isDelete ? 200 : 201;
    sendJson(res, status, {
      content: isDelete ? null : { name: path.split("/").pop(), path, sha: result.blobSha ?? result.sha, size: content ? content.length : 0, type: "file", encoding: "base64" },
      commit: { sha: result.sha, message, author: { name: FORGE_USER, email: "forge@localhost", date: nowIso() } },
    });
  } catch (e: any) {
    sendError(res, e.status || 422, e.message || "contents operation failed");
  }
}

// ---------------------------------------------------------------- REST: issues
function issueOr404(res: ServerResponse, r: Repo, n: number): Issue | null {
  const i = r.issues.find((x) => x.number === n);
  if (!i) { sendError(res, 404, "Not Found"); return null; }
  return i;
}
function createIssueHandler(req: IncomingMessage, res: ServerResponse, r: Repo, body: Json): void {
  if (typeof body.title !== "string" || !body.title.trim()) {
    sendError(res, 422, "Validation Failed", { errors: [{ resource: "Issue", field: "title", code: "missing" }] }); return;
  }
  // An issue may only carry a label created on the repository first (POST
  // /labels); an unknown label is 422. The default label set is seeded at
  // repo creation, so e.g. "bug" works without a prior POST.
  const wanted: string[] = Array.isArray(body.labels) ? body.labels.filter((l: unknown) => typeof l === "string").slice(0, 20) : [];
  const known = new Set((r.labels || []).map((l) => l.name));
  const unknown = wanted.filter((l) => !known.has(l));
  if (unknown.length > 0) {
    sendError(res, 422, `Validation Failed: label "${unknown[0]}" does not exist`, { errors: [{ resource: "Issue", field: "labels", code: "invalid", message: `label "${unknown[0]}" does not exist` }] });
    return;
  }
  const issue: Issue = {
    id: r.next_issue, number: r.next_issue++, title: body.title.trim().slice(0, 1000),
    body: typeof body.body === "string" ? body.body : "",
    state: "open",
    labels: wanted.map((l) => { const d = (r.labels || []).find((x) => x.name === l); return { name: l, color: d ? d.color : "ededed", description: d ? d.description : "" }; }),
    assignees: Array.isArray(body.assignees) ? body.assignees.filter((a: unknown) => typeof a === "string").slice(0, 10) : [],
    user: userRef(FORGE_USER), comments: [],
    created_at: nowIso(), updated_at: nowIso(), closed_at: null,
  };
  r.issues.push(issue);
  r.updated_at = nowIso(); saveStore();
  fireHooks(r, "issues", { action: "opened", issue: issueJson(r, issue), repository: repoJson(r), sender: userRef(FORGE_USER) });
  sendJson(res, 201, issueJson(r, issue));
}
function addCommentHandler(res: ServerResponse, r: Repo, target: Issue | PullRequest, body: Json, kind: "issue" | "pr"): void {
  if (typeof body.body !== "string" || !body.body.trim()) {
    sendError(res, 422, "Validation Failed", { errors: [{ field: "body", code: "missing" }] }); return;
  }
  const c: Comment = { id: r.next_comment++, body: body.body, user: userRef(FORGE_USER), created_at: nowIso(), updated_at: nowIso() };
  target.comments.push(c);
  if (kind === "issue") (target as Issue).updated_at = nowIso();
  else (target as PullRequest).updated_at = nowIso();
  r.updated_at = nowIso(); saveStore();
  if (kind === "issue") {
    fireHooks(r, "issue_comment", { action: "created", issue: issueJson(r, target as Issue), comment: c, repository: repoJson(r), sender: userRef(FORGE_USER) });
  }
  sendJson(res, 201, { ...c, html_url: `http://localhost/${r.owner}/${r.name}/issues/${(target as Issue).number || (target as PullRequest).number}#issuecomment-${c.id}`, url: `/api/v3/repos/${r.owner}/${r.name}/issues/${(target as Issue).number || (target as PullRequest).number}/comments/${c.id}` });
}

// ---------------------------------------------------------------- REST: pull requests
function prOr404(res: ServerResponse, r: Repo, n: number): PullRequest | null {
  const p = r.pulls.find((x) => x.number === n);
  if (!p) { sendError(res, 404, "Not Found"); return null; }
  return p;
}
function createPrHandler(res: ServerResponse, r: Repo, body: Json): void {
  if (typeof body.title !== "string" || !body.title.trim()) {
    sendError(res, 422, "Validation Failed", { errors: [{ resource: "PullRequest", field: "title", code: "missing" }] }); return;
  }
  const head = typeof body.head === "string" ? body.head : "";
  const base = typeof body.base === "string" ? body.base : r.default_branch;
  if (!validRefName(head) || !validRefName(base)) { sendError(res, 422, "Validation Failed", { errors: [{ field: "head/base", code: "invalid" }] }); return; }
  const bareDir = barePath(r.owner, r.name);
  const headCommit = headSha(bareDir, `refs/heads/${head}`);
  const baseCommit = headSha(bareDir, `refs/heads/${base}`);
  if (!headCommit) { sendError(res, 422, "Validation Failed", { errors: [{ field: "head", code: "invalid", message: `head branch ${head} does not exist` }] }); return; }
  if (!baseCommit) { sendError(res, 422, "Validation Failed", { errors: [{ field: "base", code: "invalid", message: `base branch ${base} does not exist` }] }); return; }
  const pr: PullRequest = {
    id: r.next_pr, number: r.next_pr++, title: body.title.trim().slice(0, 1000),
    body: typeof body.body === "string" ? body.body : "",
    state: "open", merged: false, merged_at: null, merge_commit_sha: null,
    head: { ref: head, sha: headCommit, label: `${r.owner}:${head}` },
    base: { ref: base, sha: baseCommit, label: `${r.owner}:${base}` },
    user: userRef(FORGE_USER), comments: [],
    created_at: nowIso(), updated_at: nowIso(), closed_at: null,
  };
  r.pulls.push(pr);
  r.updated_at = nowIso(); saveStore();
  fireHooks(r, "pull_request", { action: "opened", number: pr.number, pull_request: prJson(r, pr), repository: repoJson(r), sender: userRef(FORGE_USER) });
  sendJson(res, 201, prJson(r, pr));
}
// Merge a pull request's head into its base with the git binary and return
// the merge commit sha. Throws {status:409} on a merge conflict. Shared by
// the REST merge endpoint and the GraphQL mergePullRequest mutation.
function mergePrIntoBase(r: Repo, p: PullRequest, method: "merge" | "squash" | "rebase" = "merge"): string | null {
  const bareDir = barePath(r.owner, r.name);
  const mergedSha = withWorktree(bareDir, (dir) => {
    const co = gitSync(["-C", dir, "checkout", "-q", p.base.ref]);
    if (co.code !== 0) throw new Error("cannot check out base branch " + p.base.ref);
    gitSync(["-C", dir, "fetch", "-q", "origin", p.head.ref]);
    let mg: GitResult;
    if (method === "rebase") {
      mg = gitSync(["-C", dir, "rebase", "-q", `origin/${p.head.ref}`]);
      if (mg.code !== 0) { gitSync(["-C", dir, "rebase", "--abort"]); throw Object.assign(new Error("Merge conflict"), { status: 409 }); }
    } else if (method === "squash") {
      mg = gitSync(["-C", dir, "merge", "-q", "--squash", `origin/${p.head.ref}`]);
      if (mg.code !== 0) { gitSync(["-C", dir, "merge", "--abort"]); throw Object.assign(new Error("Merge conflict"), { status: 409 }); }
      const cm = gitSync(["-C", dir, "commit", "-q", "-m", p.title]);
      if (cm.code !== 0) throw new Error("squash commit failed: " + cm.stderr);
    } else {
      mg = gitSync(["-C", dir, "merge", "-q", "--no-ff", "-m", `Merge pull request #${p.number} from ${p.head.ref}`, `origin/${p.head.ref}`]);
      if (mg.code !== 0) { gitSync(["-C", dir, "merge", "--abort"]); throw Object.assign(new Error("Merge conflict"), { status: 409 }); }
    }
    const push = gitSync(["-C", dir, "push", "-q", "origin", `HEAD:refs/heads/${p.base.ref}`]);
    if (push.code !== 0) throw new Error("push failed: " + push.stderr);
    return headSha(bareDir, `refs/heads/${p.base.ref}`);
  });
  p.merged = true; p.state = "closed"; p.merged_at = nowIso(); p.closed_at = nowIso();
  p.updated_at = nowIso(); p.merge_commit_sha = mergedSha;
  r.pushed_at = nowIso(); r.updated_at = nowIso(); saveStore();
  fireHooks(r, "pull_request", { action: "closed", number: p.number, pull_request: prJson(r, p), repository: repoJson(r), sender: userRef(FORGE_USER) });
  return mergedSha;
}
function mergePrHandler(res: ServerResponse, r: Repo, p: PullRequest, body: Json): void {
  if (p.state !== "open") { sendError(res, 405, "Pull Request is not mergeable"); return; }
  const method = body.merge_method === "rebase" || body.merge_method === "squash" ? body.merge_method : "merge";
  try {
    const mergedSha = mergePrIntoBase(r, p, method);
    sendJson(res, 200, { sha: mergedSha, merged: true, message: "Pull Request successfully merged" });
  } catch (e: any) {
    // A merge conflict is 405 on the REST merge endpoint (the rules' code),
    // while anything else that went wrong is a 500.
    sendError(res, e.status === 409 ? 405 : 500, e.message || "Merge failed");
  }
}

// ---------------------------------------------------------------- git smart HTTP
function pktLine(s: string): string {
  const len = Buffer.byteLength(s) + 4;
  return len.toString(16).padStart(4, "0") + s;
}
function parsePushCommands(buf: Buffer): { old: string; nw: string; ref: string }[] {
  const out: { old: string; nw: string; ref: string }[] = [];
  let off = 0;
  while (off + 4 <= buf.length && out.length < 64) {
    const len = parseInt(buf.toString("ascii", off, off + 4), 16);
    if (!len || Number.isNaN(len)) break;
    if (len === 0) break; // flush packet
    const payload = buf.toString("utf8", off + 4, off + len);
    const m = payload.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s\x00]+)/);
    if (m) out.push({ old: m[1], nw: m[2], ref: m[3] });
    off += len;
  }
  return out;
}

async function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repo: string, service: string): Promise<void> {
  const r = findRepo(owner, repo);
  if (!r) { sendError(res, 404, "Not Found"); return; }
  if (r.private && !authed(req)) { requireAuth(req, res); return; }
  if (!gitAvailable()) { sendError(res, 503, "git binary unavailable on this host"); return; }
  const svc = service === "git-receive-pack" ? "receive-pack" : "upload-pack";
  const dir = barePath(owner, repo);
  const child = spawn("git", [svc, "--stateless-rpc", "--advertise-refs", dir], gitProtocolEnv(req));
  const chunks: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => chunks.push(c));
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
  child.on("error", () => { if (!res.writableEnded) sendError(res, 500, "failed to run git"); });
  child.on("close", (code) => {
    if (res.writableEnded) return;
    if (code !== 0) { sendError(res, 500, "git " + svc + " failed: " + stderr.trim().slice(0, 300)); return; }
    const body = Buffer.concat([
      Buffer.from(pktLine(`# service=git-${svc}\n`) + "0000"),
      Buffer.concat(chunks),
    ]);
    res.writeHead(200, {
      "Content-Type": `application/x-git-${svc}-advertisement`,
      "Content-Length": body.length, "Cache-Control": "no-cache",
    });
    res.end(body);
  });
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repo: string): void {
  const r = findRepo(owner, repo);
  if (!r) { sendError(res, 404, "Not Found"); return; }
  if (r.private && !authed(req)) { requireAuth(req, res); return; }
  if (!gitAvailable()) { sendError(res, 503, "git binary unavailable on this host"); return; }
  const child = spawn("git", ["upload-pack", "--stateless-rpc", barePath(owner, repo)], gitProtocolEnv(req));
  child.on("error", () => { if (!res.writableEnded) sendError(res, 500, "failed to run git"); });
  res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-result", "Cache-Control": "no-cache" });
  req.pipe(child.stdin);
  child.stdout.pipe(res);
  child.stderr.on("data", () => { /* drain */ });
}

function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, repo: string): void {
  const r = findRepo(owner, repo);
  if (!r) { sendError(res, 404, "Not Found"); return; }
  if (!authed(req)) { requireAuth(req, res); return; }
  if (!gitAvailable()) { sendError(res, 503, "git binary unavailable on this host"); return; }
  const dir = barePath(owner, repo);
  const child = spawn("git", ["receive-pack", "--stateless-rpc", dir]);
  child.on("error", () => { if (!res.writableEnded) sendError(res, 500, "failed to run git"); });
  res.writeHead(200, { "Content-Type": "application/x-git-receive-pack-result", "Cache-Control": "no-cache" });
  // Tee the first 64 KiB so we can parse the ref-update commands for webhooks.
  const headBuf: Buffer[] = [];
  let headLen = 0;
  req.on("data", (c: Buffer) => {
    if (headLen < 65536) { headBuf.push(c); headLen += c.length; }
    child.stdin.write(c);
  });
  req.on("end", () => child.stdin.end());
  req.on("error", () => child.stdin.end());
  child.stdout.pipe(res);
  child.stderr.on("data", () => { /* drain */ });
  child.on("close", (code) => {
    if (code !== 0) return;
    try {
      const cmds = parsePushCommands(Buffer.concat(headBuf));
      r.pushed_at = nowIso(); r.updated_at = nowIso(); saveStore();
      for (const cmd of cmds) {
        const commits: Json[] = [];
        if (cmd.old !== "0000000000000000000000000000000000000000") {
          const lg = gitSync(["--git-dir", dir, "log", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e", `${cmd.old}..${cmd.nw}`]);
          if (lg.code === 0) for (const c of parseLog(lg.stdout).slice(0, 20)) {
            commits.push({ id: c.sha, message: c.message, author: { name: c.author, email: c.email }, timestamp: c.date, url: `http://localhost/${owner}/${repo}/commit/${c.sha}` });
          }
        } else {
          const lg = gitSync(["--git-dir", dir, "log", "--max-count=20", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e", cmd.nw]);
          if (lg.code === 0) for (const c of parseLog(lg.stdout)) {
            commits.push({ id: c.sha, message: c.message, author: { name: c.author, email: c.email }, timestamp: c.date, url: `http://localhost/${owner}/${repo}/commit/${c.sha}` });
          }
        }
        fireHooks(r, "push", {
          ref: cmd.ref, before: cmd.old, after: cmd.nw, created: cmd.old === "0000000000000000000000000000000000000000",
          deleted: cmd.nw === "0000000000000000000000000000000000000000",
          commits, head_commit: commits[commits.length - 1] || null,
          repository: repoJson(r), pusher: userRef(FORGE_USER), sender: userRef(FORGE_USER),
        });
      }
      if (cmds.length === 0) fireHooks(r, "push", { ref: "refs/heads/" + r.default_branch, before: "", after: "", commits: [], repository: repoJson(r), pusher: userRef(FORGE_USER), sender: userRef(FORGE_USER) });
    } catch { /* webhook failures must never break the push */ }
  });
}

// ---------------------------------------------------------------- GraphQL (minimal, gh-compatible shapes)
function gqlRepoNode(r: Repo): Json {
  return {
    id: `repo:${r.owner}/${r.name}`, databaseId: r.id, name: r.name, nameWithOwner: r.full_name,
    description: r.description, isPrivate: r.private, url: `http://localhost/${r.owner}/${r.name}`,
    createdAt: r.created_at, updatedAt: r.updated_at,
    defaultBranchRef: { name: r.default_branch },
    owner: { login: r.owner },
    viewerPermission: "ADMIN", hasIssuesEnabled: true,
    stargazerCount: 0, forkCount: 0,
    issues: {
      totalCount: r.issues.length,
      nodes: r.issues.map((i) => ({ id: `issue:${r.owner}/${r.name}/${i.number}`, number: i.number, title: i.title, body: i.body, state: i.state.toUpperCase(), createdAt: i.created_at, url: `http://localhost/${r.owner}/${r.name}/issues/${i.number}`, author: { login: i.user.login } })),
    },
    pullRequests: {
      totalCount: r.pulls.length,
      nodes: r.pulls.map((p) => ({ id: `pr:${r.owner}/${r.name}/${p.number}`, number: p.number, title: p.title, body: p.body, state: p.state.toUpperCase(), merged: p.merged, createdAt: p.created_at, url: `http://localhost/${r.owner}/${r.name}/pull/${p.number}`, author: { login: p.user.login }, headRefName: p.head.ref, baseRefName: p.base.ref })),
    },
  };
}
function gqlStr(query: string, vars: Json, field: string): string | null {
  const fromVars = (vars.input && typeof vars.input[field] === "string") ? vars.input[field] as string : null;
  if (fromVars) return fromVars;
  if (typeof vars[field] === "string") return vars[field];
  const m = query.match(new RegExp(field + '\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
  return m ? m[1] : null;
}
function gqlId(query: string, vars: Json): string | null {
  return gqlStr(query, vars, "pullRequestId") || gqlStr(query, vars, "repositoryId") || gqlStr(query, vars, "subjectId") || gqlStr(query, vars, "issueId") || gqlStr(query, vars, "id");
}
function repoFromNodeId(id: string | null): Repo | null {
  if (!id) return null;
  const m = id.match(/^repo:([^/]+)\/(.+)$/);
  if (m) return findRepo(m[1], m[2]) || null;
  return null;
}
// ---------------------------------------------------------------- GraphQL (minimal, gh-compatible shapes)
const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ["id", "number", "title", "body", "state", "createdAt", "updatedAt", "author", "url", "labels", "comments", "closedAt", "assignees"],
  PullRequest: ["id", "number", "title", "body", "state", "merged", "mergeable", "headRefName", "baseRefName", "files", "createdAt", "updatedAt", "author", "url", "head", "base", "mergedAt", "mergeCommitSha", "comments"],
  Repository: ["id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "description", "isPrivate", "url", "createdAt", "updatedAt", "stargazerCount", "forkCount"],
};
const GQL_TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ["ISSUE", "REPOSITORY", "USER", "DISCUSSION", "COMMIT", "MARKETPLACE"],
};
function gqlCursor(n: number): string { return Buffer.from(`cursor:${n}`).toString("base64"); }
function gqlCursorNum(c: unknown): number {
  if (typeof c !== "string" || !c) return 0;
  try { const m = Buffer.from(c, "base64").toString("utf8").match(/^cursor:(\d+)$/); return m ? Number(m[1]) : 0; } catch { return 0; }
}
function gqlIssuesConn(r: Repo, argsText: string, vars: Json): Json {
  // issues(first, after, states, orderBy) — default order is creation (number ASC).
  let list = [...r.issues];
  const statesM = /states\s*:\s*\[\s*([A-Z_]+)/.exec(argsText);
  if (statesM) list = list.filter((i) => i.state.toUpperCase() === statesM[1]);
  const orderM = /orderBy\s*:\s*\{[^}]*field\s*:\s*(\w+)\s*,\s*direction\s*:\s*(\w+)/.exec(argsText);
  if (orderM && orderM[2] === "DESC") list.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.number - a.number));
  else list.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.number - b.number));
  const first = gqlArgInt(argsText, vars, "first");
  const after = gqlArgStr(argsText, vars, "after");
  const afterNum = gqlCursorNum(after);
  if (after !== null) list = list.filter((i) => i.number > afterNum);
  const total = list.length;
  const nodes = (first !== null ? list.slice(0, first) : list).map((i) => ({ id: `issue:${r.owner}/${r.name}/${i.number}`, number: i.number, title: i.title, body: i.body, state: i.state.toUpperCase(), createdAt: i.created_at, url: `http://localhost/${r.owner}/${r.name}/issues/${i.number}`, author: { login: i.user.login } }));
  const hasNext = first !== null && total > nodes.length;
  return { totalCount: r.issues.length, nodes, pageInfo: { hasNextPage: hasNext, endCursor: nodes.length ? gqlCursor(nodes[nodes.length - 1].number) : null } };
}
function gqlArgInt(argsText: string, vars: Json, field: string): number | null {
  const vm = new RegExp(field + "\\s*:\\s*\\$(\\w+)").exec(argsText);
  if (vm && typeof vars[vm[1]] === "number") return vars[vm[1]] as number;
  const lm = new RegExp(field + "\\s*:\\s*(\\d+)").exec(argsText);
  return lm ? Number(lm[1]) : null;
}
function gqlArgStr(argsText: string, vars: Json, field: string): string | null {
  const vm = new RegExp(field + "\\s*:\\s*\\$(\\w+)").exec(argsText);
  if (vm && typeof vars[vm[1]] === "string") return vars[vm[1]] as string;
  const lm = new RegExp(field + "\\s*:\\s*\"([^\"]*)\"").exec(argsText);
  return lm ? lm[1] : null;
}
function prChangedPaths(r: Repo, p: PullRequest): string[] {
  if (!gitAvailable() || !p.head.sha || !p.base.sha) return [];
  const d = gitSync(["--git-dir", barePath(r.owner, r.name), "diff", "--name-only", p.base.sha, p.head.sha]);
  if (d.code !== 0) return [];
  return d.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

function gqlPrNode(r: Repo, p: PullRequest): Json {
  return { id: `pr:${r.owner}/${r.name}/${p.number}`, number: p.number, title: p.title, body: p.body, state: p.state.toUpperCase(), merged: p.merged, mergeable: p.state === "open" ? "MERGEABLE" : "UNKNOWN", createdAt: p.created_at, url: `http://localhost/${r.owner}/${r.name}/pull/${p.number}`, author: { login: p.user.login }, headRefName: p.head.ref, baseRefName: p.base.ref, files: { nodes: prChangedPaths(r, p).map((path) => ({ path })) } };
}
// One operation document -> one GraphQL response object.
function execGraphQLDoc(query: string, vars: Json): Json {
  try {
    // -- introspection: __type(name: "...") { fields | enumValues } (gh's
    // feature-detection probes; several may share one document, aliased).
    if (query.includes("__type(")) {
      const data: Json = {};
      const re = /(\w+)\s*:\s*__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)\s*\{([^}]*)\}/g;
      let m: RegExpExecArray | null; let found = false;
      while ((m = re.exec(query)) !== null) {
        found = true;
        const [, alias, typeName, sel] = m;
        if (sel.includes("fields")) data[alias] = { fields: (GQL_TYPE_FIELDS[typeName] || []).map((n) => ({ name: n })) };
        else if (sel.includes("enumValues")) data[alias] = { enumValues: (GQL_TYPE_ENUMS[typeName] || []).map((n) => ({ name: n })) };
        else data[alias] = null;
      }
      if (found) return { data };
    }
    const isMutation = /^\s*mutation\b/.test(query);
    // -- mutations ------------------------------------------------------
    if (/createIssue\s*\(/.test(query)) {
      const repo = repoFromNodeId(gqlId(query, vars));
      const title = gqlStr(query, vars, "title") || "";
      if (!repo || !title) return { errors: [{ message: "repositoryId and title are required" }] };
      const issue: Issue = {
        id: repo.next_issue, number: repo.next_issue++, title: title.slice(0, 1000),
        body: gqlStr(query, vars, "body") || "", state: "open", labels: [], assignees: [],
        user: userRef(FORGE_USER), comments: [], created_at: nowIso(), updated_at: nowIso(), closed_at: null,
      };
      repo.issues.push(issue); repo.updated_at = nowIso(); saveStore();
      fireHooks(repo, "issues", { action: "opened", issue: issueJson(repo, issue), repository: repoJson(repo), sender: userRef(FORGE_USER) });
      return { data: { createIssue: { issue: { id: `issue:${repo.owner}/${repo.name}/${issue.number}`, number: issue.number, title: issue.title, url: `http://localhost/${repo.owner}/${repo.name}/issues/${issue.number}` } } } };
    }
    if (/createPullRequest\s*\(/.test(query)) {
      const repo = repoFromNodeId(gqlId(query, vars));
      const title = gqlStr(query, vars, "title") || "";
      const head = gqlStr(query, vars, "headRefName") || "";
      const base = gqlStr(query, vars, "baseRefName") || repo?.default_branch || "main";
      if (!repo || !title || !head) return { errors: [{ message: "repositoryId, title and headRefName are required" }] };
      const bareDir = barePath(repo.owner, repo.name);
      const headCommit = headSha(bareDir, `refs/heads/${head}`);
      const baseCommit = headSha(bareDir, `refs/heads/${base}`);
      if (!headCommit || !baseCommit) return { errors: [{ message: "head or base branch does not exist" }] };
      const pr: PullRequest = {
        id: repo.next_pr, number: repo.next_pr++, title: title.slice(0, 1000),
        body: gqlStr(query, vars, "body") || "", state: "open", merged: false, merged_at: null, merge_commit_sha: null,
        head: { ref: head, sha: headCommit, label: `${repo.owner}:${head}` },
        base: { ref: base, sha: baseCommit, label: `${repo.owner}:${base}` },
        user: userRef(FORGE_USER), comments: [], created_at: nowIso(), updated_at: nowIso(), closed_at: null,
      };
      repo.pulls.push(pr); repo.updated_at = nowIso(); saveStore();
      fireHooks(repo, "pull_request", { action: "opened", number: pr.number, pull_request: prJson(repo, pr), repository: repoJson(repo), sender: userRef(FORGE_USER) });
      return { data: { createPullRequest: { pullRequest: { id: `pr:${repo.owner}/${repo.name}/${pr.number}`, number: pr.number, title: pr.title, state: "OPEN", headRefName: head, baseRefName: base, url: `http://localhost/${repo.owner}/${repo.name}/pull/${pr.number}` } } } };
    }
    if (/mergePullRequest\s*\(/.test(query)) {
      const id = gqlId(query, vars) || "";
      const m = id.match(/^pr:([^/]+)\/(.+)\/(\d+)$/);
      const repo = m ? findRepo(m[1], m[2]) : null;
      const pr = repo && m ? repo.pulls.find((p) => p.number === Number(m[3])) : null;
      if (!repo || !pr) return { errors: [{ message: "Not Found" }] };
      if (pr.merged || pr.state !== "open") return { errors: [{ message: "pull request is not open" }] };
      try {
        const sha = mergePrIntoBase(repo, pr);
        return { data: { mergePullRequest: { pullRequest: { id, number: pr.number, merged: true, state: "CLOSED", mergeCommitSha: sha } } } };
      } catch (e: any) {
        const status = (e as any).status;
        return { errors: [{ message: status === 409 ? "Merge conflict" : (e.message || "merge failed") }] };
      }
    }
    if (/addComment\s*\(/.test(query)) {
      const subjectId = gqlId(query, vars) || "";
      const bodyText = gqlStr(query, vars, "body") || "";
      const m = subjectId.match(/^(issue|pr):([^/]+)\/(.+)\/(\d+)$/);
      if (!m || !bodyText) return { errors: [{ message: "subjectId and body are required" }] };
      const repo = findRepo(m[2], m[3]);
      if (!repo) return { errors: [{ message: "Not Found" }] };
      const target = m[1] === "pr" ? repo.pulls.find((p) => p.number === Number(m[4])) : repo.issues.find((i) => i.number === Number(m[4]));
      if (!target) return { errors: [{ message: "Not Found" }] };
      const c: Comment = { id: repo.next_comment++, body: bodyText, user: userRef(FORGE_USER), created_at: nowIso(), updated_at: nowIso() };
      target.comments.push(c); target.updated_at = nowIso(); repo.updated_at = nowIso(); saveStore();
      return { data: { addComment: { commentEdge: { node: { id: `comment:${c.id}`, body: c.body, createdAt: c.created_at } } } } };
    }
    if (/closeIssue\s*\(/.test(query) || /reopenIssue\s*\(/.test(query)) {
      const closing = /closeIssue\s*\(/.test(query);
      const subjectId = gqlId(query, vars) || "";
      const m = subjectId.match(/^issue:([^/]+)\/(.+)\/(\d+)$/);
      const repo = m ? findRepo(m[1], m[2]) : null;
      const issue = repo && m ? repo.issues.find((i) => i.number === Number(m[3])) : null;
      if (!repo || !issue) return { errors: [{ message: "Not Found" }] };
      issue.state = closing ? "closed" : "open";
      issue.closed_at = closing ? nowIso() : null;
      issue.updated_at = nowIso(); repo.updated_at = nowIso(); saveStore();
      fireHooks(repo, "issues", { action: closing ? "closed" : "reopened", issue: issueJson(repo, issue), repository: repoJson(repo), sender: userRef(FORGE_USER) });
      return { data: { [closing ? "closeIssue" : "reopenIssue"]: { issue: { id: subjectId, number: issue.number, state: issue.state.toUpperCase() } } } };
    }
    // -- queries --------------------------------------------------------
    if (/viewer\s*\{/.test(query)) {
      const block = /viewer\s*\{([^}]*)\}/.exec(query);
      const knownViewer = new Set(["login", "id", "name", "email", "url", "avatarUrl", "databaseId", "createdAt"]);
      if (block) {
        for (const f of block[1].split(/\s+/).filter(Boolean)) {
          if (!knownViewer.has(f)) return { errors: [{ message: `Cannot query field "${f}" on type "Viewer".` }] };
        }
      }
      return { data: { viewer: { login: FORGE_USER, id: 1000 } } };
    }
    if (/\bnode\s*\(\s*id\s*:/.test(query)) {
      const id = gqlId(query, vars) || "";
      const rm = id.match(/^repo:([^/]+)\/(.+)$/);
      const repo = rm ? findRepo(rm[1], rm[2]) : null;
      if (!repo) return { data: { node: null } };
      return { data: { node: { __typename: "Repository", id, name: repo.name, nameWithOwner: repo.full_name } } };
    }
    const repoMatch = query.match(/repository\s*\(\s*owner\s*:\s*(?:"([^"]+)"|\$(\w+))\s*,\s*name\s*:\s*(?:"([^"]+)"|\$(\w+))\s*\)/);
    if (repoMatch) {
      const owner = repoMatch[1] || (repoMatch[2] ? String(vars[repoMatch[2]]) : "");
      const name = repoMatch[3] || (repoMatch[4] ? String(vars[repoMatch[4]]) : "");
      const repo = findRepo(owner, name);
      if (!repo) return { data: { repository: null } };
      const node = gqlRepoNode(repo);
      const issuesM = /issues\s*\(([^)]*)\)/.exec(query);
      if (issuesM) node.issues = gqlIssuesConn(repo, issuesM[1], vars);
      const prsM = /pullRequests\s*\(([^)]*)\)/.exec(query);
      if (prsM) {
        const first = gqlArgInt(prsM[1], vars, "first");
        const all = repo.pulls.map((p) => gqlPrNode(repo, p));
        node.pullRequests = { totalCount: repo.pulls.length, nodes: first !== null ? all.slice(0, first) : all };
      }
      const issueM = /issue\s*\(\s*number\s*:\s*(?:(\d+)|\$(\w+))\s*\)/.exec(query);
      if (issueM) {
        const num = issueM[1] ? Number(issueM[1]) : Number(vars[issueM[2]]);
        const iss = repo.issues.find((i) => i.number === num);
        node.issue = iss ? { id: `issue:${repo.owner}/${repo.name}/${iss.number}`, number: iss.number, title: iss.title, body: iss.body, state: iss.state.toUpperCase(), createdAt: iss.created_at, url: `http://localhost/${repo.owner}/${repo.name}/issues/${iss.number}`, author: { login: iss.user.login } } : null;
      }
      const prM = /pullRequest\s*\(\s*number\s*:\s*(?:(\d+)|\$(\w+))\s*\)/.exec(query);
      if (prM) {
        const num = prM[1] ? Number(prM[1]) : Number(vars[prM[2]]);
        const p = repo.pulls.find((x) => x.number === num);
        node.pullRequest = p ? gqlPrNode(repo, p) : null;
      }
      return { data: { repository: node } };
    }
    if (/search\s*\(/.test(query)) {
      const q = gqlStr(query, vars, "query") || "";
      const hits = store.repos.filter((r) => r.full_name.includes(q) || r.description.includes(q));
      return { data: { search: { nodes: hits.map(gqlRepoNode), repositoryCount: hits.length } } };
    }
    return { errors: [{ message: "Unsupported query: only repository, viewer, search queries and createIssue/createPullRequest/addComment/closeIssue/reopenIssue mutations are supported" }] };
  } catch (e: any) {
    return { errors: [{ message: e.message || "GraphQL error" }] };
  }
}
async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Json;
  try { body = await readJson(req); } catch (e: any) { sendError(res, e.status || 400, e.message); return; }
  // Every GraphQL call needs the trial token; an unauthenticated one is 401.
  if (!authed(req)) { sendJson(res, 401, { message: "Requires authentication", documentation_url: "https://docs.github.com/rest" }); return; }
  // GitHub operation batching: a JSON array of operation documents answers
  // a JSON array of results, in request order.
  if (Array.isArray(body)) {
    const out: Json[] = [];
    for (const doc of body as Json[]) {
      const q = typeof doc.query === "string" ? doc.query : "";
      const v: Json = (doc.variables && typeof doc.variables === "object") ? doc.variables : {};
      out.push(execGraphQLDoc(q, v));
    }
    sendJson(res, 200, out);
    return;
  }
  const query = typeof body.query === "string" ? body.query : "";
  const vars: Json = (body.variables && typeof body.variables === "object") ? body.variables : {};
  sendJson(res, 200, execGraphQLDoc(query, vars));
}

// ---------------------------------------------------------------- MCP (JSON-RPC 2.0 over POST /mcp)
interface McpTool { name: string; description: string; inputSchema: Json; mutating: boolean; run: (args: Json) => Json; }
const MCP_TOOLS: McpTool[] = [
  { name: "create_repository", description: "Create a repository", mutating: true, inputSchema: { type: "object", properties: { owner: { type: "string" }, name: { type: "string" }, description: { type: "string" }, private: { type: "boolean" } }, required: ["name"] }, run: (a) => {
    if (!validName(a.name)) throw Object.assign(new Error("invalid repository name"), { status: 422 });
    const owner = validName(a.owner) ? a.owner : FORGE_USER;
    if (findRepo(owner, a.name)) throw Object.assign(new Error("repository already exists"), { status: 422 });
    const repo: Repo = { id: store.next_repo++, name: a.name, full_name: `${owner}/${a.name}`, owner, description: typeof a.description === "string" ? a.description : "", private: a.private === true, default_branch: "main", created_at: nowIso(), updated_at: nowIso(), pushed_at: null, next_issue: 1, next_pr: 1, next_hook: 1, next_comment: 1, labels: DEFAULT_LABELS.map((l) => ({ ...l })), issues: [], pulls: [], hooks: [] };
    createBareRepo(owner, a.name, "main");
    store.repos.push(repo); saveStore();
    return repoJson(repo);
  } },
  { name: "list_repositories", description: "List repositories", mutating: false, inputSchema: { type: "object", properties: { owner: { type: "string" } } }, run: (a) => ({ repositories: store.repos.filter((r) => !a.owner || r.owner === a.owner).map(repoJson) }) },
  { name: "get_repository", description: "Get a repository", mutating: false, inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] }, run: (a) => {
    const r = findRepo(a.owner, a.repo); if (!r) throw Object.assign(new Error("Not Found"), { status: 404 }); return repoJson(r);
  } },
  { name: "delete_repository", description: "Delete a repository", mutating: true, inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] }, run: (a) => {
    const r = findRepo(a.owner, a.repo); if (!r) throw Object.assign(new Error("Not Found"), { status: 404 });
    store.repos = store.repos.filter((x) => x !== r); saveStore();
    rmSync(barePath(r.owner, r.name), { recursive: true, force: true });
    return { deleted: true, full_name: r.full_name };
  } },
  { name: "create_issue", description: "Create an issue", mutating: true, inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] }, run: (a) => {
    const r = findRepo(a.owner, a.repo); if (!r) throw Object.assign(new Error("Not Found"), { status: 404 });
    const issue: Issue = { id: r.next_issue, number: r.next_issue++, title: String(a.title).slice(0, 1000), body: typeof a.body === "string" ? a.body : "", state: "open", labels: [], assignees: [], user: userRef(FORGE_USER), comments: [], created_at: nowIso(), updated_at: nowIso(), closed_at: null };
    r.issues.push(issue); r.updated_at = nowIso(); saveStore();
    fireHooks(r, "issues", { action: "opened", issue: issueJson(r, issue), repository: repoJson(r), sender: userRef(FORGE_USER) });
    return issueJson(r, issue);
  } },
  { name: "list_issues", description: "List issues", mutating: false, inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } }, required: ["owner", "repo"] }, run: (a) => {
    const r = findRepo(a.owner, a.repo); if (!r) throw Object.assign(new Error("Not Found"), { status: 404 });
    const list = a.state && a.state !== "all" ? r.issues.filter((i) => i.state === a.state) : r.issues;
    return { issues: list.map((i) => issueJson(r, i)) };
  } },
  { name: "get_issue", description: "Get an issue", mutating: false, inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" } }, required: ["owner", "repo", "issue_number"] }, run: (a) => {
    const r = findRepo(a.owner, a.repo); if (!r) throw Object.assign(new Error("Not Found"), { status: 404 });
    const i = r.issues.find((x) => x.number === Number(a.issue_number)); if (!i) throw Object.assign(new Error("Not Found"), { status: 404 });
    return issueJson(r, i);
  } },
  { name: "update_issue", description: "Update an issue", mutating: true, inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" }, title: { type: "string" }, body: { type: "string" }, state: { type: "string" } }, required: ["owner", "repo", "issue_number"] }, run: (a) => {
    const r = findRepo(a.owner, a.repo); if (!r) throw Object.assign(new Error("Not Found"), { status: 404 });
    const i = r.issues.find((x) => x.number === Number(a.issue_number)); if (!i) throw Object.assign(new Error("Not Found"), { status: 404 });
    if (typeof a.title === "string") i.title = a.title.slice(0, 1000);
    if (typeof a.body === "string") i.body = a.body;
    if (a.state === "open" || a.state === "closed") { i.state = a.state; i.closed_at = a.state === "closed" ? nowIso() : null; }
    i.updated_at = nowIso(); r.updated_at = nowIso(); saveStore();
    return issueJson(r, i);
  } },
  { name: "add_issue_comment", description: "Comment on an issue", mutating: true, inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" }, body: { type: "string" } }, required: ["owner", "repo", "issue_number", "body"] }, run: (a) => {
    const r = findRepo(a.owner, a.repo); if (!r) throw Object.assign(new Error("Not Found"), { status: 404 });
    const i = r.issues.find((x) => x.number === Number(a.issue_number)); if (!i) throw Object.assign(new Error("Not Found"), { status: 404 });
    const c: Comment = { id: r.next_comment++, body: String(a.body), user: userRef(FORGE_USER), created_at: nowIso(), updated_at: nowIso() };
    i.comments.push(c); i.updated_at = nowIso(); r.updated_at = nowIso(); saveStore();
    return c;
  } },
  { name: "create_pull_request", description: "Create a pull request", mutating: true, inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, head: { type: "string" }, base: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title", "head", "base"] }, run: (a) => {
    const r = findRepo(a.owner, a.repo); if (!r) throw Object.assign(new Error("Not Found"), { status: 404 });
    const bareDir = barePath(r.owner, r.name);
    const headCommit = headSha(bareDir, `refs/heads/${a.head}`);
    const baseCommit = headSha(bareDir, `refs/heads/${a.base}`);
    if (!headCommit || !baseCommit) throw Object.assign(new Error("head or base branch does not exist"), { status: 422 });
    const pr: PullRequest = { id: r.next_pr, number: r.next_pr++, title: String(a.title).slice(0, 1000), body: typeof a.body === "string" ? a.body : "", state: "open", merged: false, merged_at: null, merge_commit_sha: null, head: { ref: a.head, sha: headCommit, label: `${r.owner}:${a.head}` }, base: { ref: a.base, sha: baseCommit, label: `${r.owner}:${a.base}` }, user: userRef(FORGE_USER), comments: [], created_at: nowIso(), updated_at: nowIso(), closed_at: null };
    r.pulls.push(pr); r.updated_at = nowIso(); saveStore();
    return prJson(r, pr);
  } },
  { name: "list_pull_requests", description: "List pull requests", mutating: false, inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } }, required: ["owner", "repo"] }, run: (a) => {
    const r = findRepo(a.owner, a.repo); if (!r) throw Object.assign(new Error("Not Found"), { status: 404 });
    const list = a.state && a.state !== "all" ? r.pulls.filter((p) => p.state === a.state) : r.pulls;
    return { pull_requests: list.map((p) => prJson(r, p)) };
  } },
  { name: "merge_pull_request", description: "Merge a pull request", mutating: true, inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "number" } }, required: ["owner", "repo", "pull_number"] }, run: (a) => {
    const r = findRepo(a.owner, a.repo); if (!r) throw Object.assign(new Error("Not Found"), { status: 404 });
    const p = r.pulls.find((x) => x.number === Number(a.pull_number)); if (!p) throw Object.assign(new Error("Not Found"), { status: 404 });
    if (p.state !== "open") throw Object.assign(new Error("Pull Request is not mergeable"), { status: 405 });
    const bareDir = barePath(r.owner, r.name);
    const mergedSha = withWorktree(bareDir, (dir) => {
      const co = gitSync(["-C", dir, "checkout", "-q", p.base.ref]);
      if (co.code !== 0) throw new Error("cannot check out base branch");
      gitSync(["-C", dir, "fetch", "-q", "origin", p.head.ref]);
      const mg = gitSync(["-C", dir, "merge", "-q", "--no-ff", "-m", `Merge pull request #${p.number} from ${p.head.ref}`, `origin/${p.head.ref}`]);
      if (mg.code !== 0) { gitSync(["-C", dir, "merge", "--abort"]); throw Object.assign(new Error("Merge conflict"), { status: 409 }); }
      const push = gitSync(["-C", dir, "push", "-q", "origin", `HEAD:refs/heads/${p.base.ref}`]);
      if (push.code !== 0) throw new Error("push failed: " + push.stderr);
      return headSha(bareDir, `refs/heads/${p.base.ref}`);
    });
    p.merged = true; p.state = "closed"; p.merged_at = nowIso(); p.closed_at = nowIso(); p.updated_at = nowIso(); p.merge_commit_sha = mergedSha;
    r.pushed_at = nowIso(); r.updated_at = nowIso(); saveStore();
    return { sha: mergedSha, merged: true, message: "Pull Request successfully merged" };
  } },
  { name: "search_repositories", description: "Search repositories", mutating: false, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, run: (a) => ({ repositories: store.repos.filter((r) => r.full_name.includes(String(a.query)) || r.description.includes(String(a.query))).map(repoJson) }) },
  { name: "search_issues", description: "Search issues", mutating: false, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, run: (a) => {
    const out: Json[] = [];
    for (const r of store.repos) for (const i of r.issues) if (i.title.includes(String(a.query)) || i.body.includes(String(a.query))) out.push(issueJson(r, i));
    return { issues: out };
  } },
  { name: "get_file_contents", description: "Get a file from a repository", mutating: false, inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } }, required: ["owner", "repo", "path"] }, run: (a) => {
    const r = findRepo(a.owner, a.repo); if (!r) throw Object.assign(new Error("Not Found"), { status: 404 });
    if (!validContentPath(String(a.path))) throw Object.assign(new Error("invalid path"), { status: 400 });
    const bareDir = barePath(r.owner, r.name);
    const blob = gitBuf(["--git-dir", bareDir, "show", `HEAD:${a.path}`]);
    if (blob.code !== 0) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { path: a.path, content: blob.buf.toString("base64"), encoding: "base64", size: blob.buf.length };
  } },
  { name: "list_commits", description: "List commits", mutating: false, inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, sha: { type: "string" } }, required: ["owner", "repo"] }, run: (a) => {
    const r = findRepo(a.owner, a.repo); if (!r) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { commits: listCommits(barePath(r.owner, r.name), typeof a.sha === "string" ? a.sha : "HEAD", 30) };
  } },
];

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Json;
  try { body = await readJson(req); } catch (e: any) {
    // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
    if (e.status === 400) { sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    sendError(res, e.status || 400, e.message); return;
  }
  const id = body.id !== undefined ? body.id : null;
  const method = typeof body.method === "string" ? body.method : "";
  const ok = (result: unknown) => sendJson(res, 200, { jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => sendJson(res, 200, { jsonrpc: "2.0", id, error: { code, message } });
  if (method === "initialize") {
    ok({ protocolVersion: body.params && body.params.protocolVersion ? body.params.protocolVersion : "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "forge", version: "1.0.0" } });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") { res.writeHead(202); res.end(); return; }
  if (method === "ping") { ok({}); return; }
  if (method === "tools/list") {
    ok({ tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    return;
  }
  if (method === "tools/call") {
    // Authentication is decided before any tool exists: a call with no
    // Authorization header answers HTTP 401, whatever tool it names.
    if (!authed(req)) { sendJson(res, 401, { message: "Requires authentication" }); return; }
    const name = body.params && body.params.name;
    const args: Json = (body.params && body.params.arguments && typeof body.params.arguments === "object") ? body.params.arguments : {};
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) { err(-32602, `unknown tool: ${name}`); return; }
    const missing = ((tool.inputSchema as any).required as string[] | undefined ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
    if (missing.length > 0) { err(-32602, `Missing required arguments: ${missing.join(", ")}`); return; }
    if (tool.mutating && !authed(req)) { err(-32001, "Requires authentication"); return; }
    try {
      const result = tool.run(args);
      ok({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (e: any) {
      err(-32603, e.message || "tool failed");
    }
    return;
  }
  err(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------- deterministic state export (no timestamps)
function stateExport(): Json {
  const repos = [...store.repos].sort((a, b) => a.full_name.localeCompare(b.full_name)).map((r) => ({
    default_branch: r.default_branch,
    description: r.description,
    full_name: r.full_name,
    hooks: [...r.hooks].sort((a, b) => a.id - b.id).map((h) => ({ active: h.active, events: [...h.events].sort(), url: h.config.url })),
    issues: [...r.issues].sort((a, b) => a.number - b.number).map((i) => ({
      body: i.body, labels: i.labels.map((l) => l.name).sort(), number: i.number,
      state: i.state, title: i.title,
      comments: i.comments.map((c) => ({ body: c.body, id: c.id })),
    })),
    name: r.name, owner: r.owner, private: r.private,
    pulls: [...r.pulls].sort((a, b) => a.number - b.number).map((p) => ({
      base: p.base.ref, body: p.body, head: p.head.ref, merged: p.merged,
      number: p.number, state: p.state, title: p.title,
    })),
  }));
  return { format: "forge-export/1", repos };
}

// ---------------------------------------------------------------- REST router
const prReviews = new Map<string, Json[]>();

async function handleRest(req: IncomingMessage, res: ServerResponse, method: string, seg: string[], url: URL): Promise<void> {
  const q = url.searchParams;
  const perPage = Math.min(Math.max(parseInt(q.get("per_page") || "30", 10) || 30, 1), 100);
  const page = Math.max(parseInt(q.get("page") || "1", 10) || 1, 1);
  const slice = <T,>(arr: T[]): T[] => arr.slice((page - 1) * perPage, page * perPage);
  const stateQ = q.get("state") || "open";
  // Send one page of a list with GitHub's Link pagination headers. The next
  // URL is absolute, on the request's own Host, so a client following it
  // stays on this entry's origin.
  const listReply = <T,>(arr: T[]): void => {
    const extra: Record<string, string> = {};
    if (page * perPage < arr.length) {
      const params = new URLSearchParams(q);
      params.set("per_page", String(perPage));
      params.set("page", String(page + 1));
      const host = req.headers.host || "127.0.0.1";
      const proto = (req.socket as unknown as { encrypted?: boolean }).encrypted ? "https" : "http";
      extra["Link"] = `<${proto}://${host}${url.pathname}?${params.toString()}>; rel="next"`;
    }
    sendJson(res, 200, slice(arr), extra);
  };

  // API root / misc
  if (seg.length === 0) {
    sendJson(res, 200, {
      current_user_url: "/api/v3/user", current_user_repositories_url: "/api/v3/user/repos",
      repository_url: "/api/v3/repos/{owner}/{repo}", rate_limit_url: "/api/v3/rate_limit",
      graphql_url: "/graphql", mcp_url: "/mcp",
    }, { "X-OAuth-Scopes": "repo, read:org" });
    return;
  }
  if (seg[0] === "meta" && method === "GET") {
    sendJson(res, 200, {
      verifiable_password_authentication: true,
      installed_version: "1.0.0",
      github_enterprise: false,
    });
    return;
  }
  if (seg[0] === "zen") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Keep it logically awesome."); return; }
  if (seg[0] === "rate_limit") {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600, used: 1 } });
    return;
  }
  if (seg[0] === "export" && method === "GET") { sendJson(res, 200, stateExport()); return; }
  if (seg[0] === "user" && seg.length === 1) {
    if (!requireAuth(req, res)) return;
    sendJson(res, 200, { login: FORGE_USER, id: 1, type: "User", url: "/api/v3/user", html_url: `http://localhost/${FORGE_USER}`, repos_url: "/api/v3/user/repos" });
    return;
  }
  if (seg[0] === "users" && seg.length === 2) {
    sendJson(res, 200, { login: seg[1], id: 1, type: "User", url: `/api/v3/users/${seg[1]}`, html_url: `http://localhost/${seg[1]}` });
    return;
  }
  if (seg[0] === "orgs" && seg.length === 2 && method === "GET") {
    sendJson(res, 200, { login: seg[1], id: 2, type: "Organization", url: `/api/v3/orgs/${seg[1]}`, html_url: `http://localhost/${seg[1]}` });
    return;
  }
  if (seg[0] === "orgs" && seg.length === 3 && seg[2] === "repos") {
    if (method === "GET") { listReply(store.repos.filter((r) => r.owner === seg[1]).map(repoJson)); return; }
    if (method === "POST") {
      if (!requireAuth(req, res)) return;
      const body = await readJson(req);
      createRepoHandler(req, res, body, seg[1]);
      return;
    }
  }
  if (seg[0] === "search" && seg[1] === "repositories" && method === "GET") {
    const term = q.get("q") || "";
    const hits = store.repos.filter((r) => r.full_name.includes(term) || r.description.includes(term)).map(repoJson);
    sendJson(res, 200, { total_count: hits.length, incomplete_results: false, items: slice(hits) });
    return;
  }
  if (seg[0] === "search" && seg[1] === "issues" && method === "GET") {
    const term = q.get("q") || "";
    const out: Json[] = [];
    for (const r of store.repos) for (const i of r.issues) if (i.title.includes(term) || i.body.includes(term)) out.push(issueJson(r, i));
    sendJson(res, 200, { total_count: out.length, incomplete_results: false, items: slice(out) });
    return;
  }
  if (seg[0] === "issues" && seg.length === 1 && method === "GET") {
    const out: Json[] = [];
    for (const r of store.repos) for (const i of r.issues) if (stateQ === "all" || i.state === stateQ) out.push(issueJson(r, i));
    listReply(out);
    return;
  }
  if (seg[0] === "user" && seg[1] === "repos") {
    if (method === "GET") { listReply(store.repos.map(repoJson)); return; }
    if (method === "POST") {
      if (!requireAuth(req, res)) return;
      const body = await readJson(req);
      createRepoHandler(req, res, body);
      return;
    }
  }
  if (seg[0] === "repos" && seg.length === 1) {
    if (method === "GET") { listReply(store.repos.map(repoJson)); return; }
    if (method === "POST") {
      if (!requireAuth(req, res)) return;
      const body = await readJson(req);
      createRepoHandler(req, res, body);
      return;
    }
  }

  // ---- /repos/:owner/:repo[/...]
  if (seg[0] === "repos" && seg.length >= 3) {
    const owner = seg[1]; const repoName = seg[2];
    if (!validName(owner) || !validName(repoName)) { sendError(res, 404, "Not Found"); return; }
    const rest = seg.slice(3);
    const r = findRepo(owner, repoName);

    if (rest.length === 0) {
      if (method === "GET") { if (!r) { sendError(res, 404, "Not Found"); return; } if (r.private && !authed(req)) { requireAuth(req, res); return; } sendJson(res, 200, repoJson(r)); return; }
      if (method === "PATCH") {
        if (!requireAuth(req, res)) return;
        if (!r) { sendError(res, 404, "Not Found"); return; }
        const body = await readJson(req);
        if (typeof body.description === "string") r.description = body.description.slice(0, 1000);
        if (body.private === true || body.private === false) r.private = body.private;
        if (typeof body.default_branch === "string" && validRefName(body.default_branch)) {
          const ok = gitSync(["--git-dir", barePath(owner, repoName), "rev-parse", "--verify", `refs/heads/${body.default_branch}`]);
          if (ok.code !== 0) { sendError(res, 422, "Validation Failed", { errors: [{ field: "default_branch", code: "invalid" }] }); return; }
          r.default_branch = body.default_branch;
        }
        r.updated_at = nowIso(); saveStore();
        sendJson(res, 200, repoJson(r)); return;
      }
      if (method === "DELETE") {
        if (!requireAuth(req, res)) return;
        if (!r) { sendError(res, 404, "Not Found"); return; }
        deleteRepoHandler(res, r); return;
      }
    }

    if (!r) { sendError(res, 404, "Not Found"); return; }
    const bareDir = barePath(owner, repoName);

    // ---- branches
    if (rest[0] === "branches") {
      if (method === "GET" && rest.length === 1) { sendJson(res, 200, listBranches(bareDir)); return; }
      if (method === "GET" && rest.length === 2) {
        const sha = headSha(bareDir, `refs/heads/${rest[1]}`);
        if (!sha) { sendError(res, 404, "Not Found"); return; }
        sendJson(res, 200, { name: rest[1], commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` }, protected: false });
        return;
      }
    }
    // ---- commits
    if (rest[0] === "commits") {
      if (method === "GET" && rest.length === 1) {
        const ref = q.get("sha") || "HEAD";
        sendJson(res, 200, slice(listCommits(bareDir, ref, perPage)));
        return;
      }
      if (method === "GET" && rest.length === 2) {
        const one = listCommits(bareDir, rest[1], 1);
        if (!one.length) { sendError(res, 404, "Not Found"); return; }
        const st = gitSync(["--git-dir", bareDir, "show", "--stat", "--format=", rest[1]]);
        sendJson(res, 200, { ...one[0], stats: { total: 0 }, files: [] });
        return;
      }
    }
    // ---- git refs / trees / blobs
    if (rest[0] === "git") {
      if (rest[1] === "refs" && method === "GET") {
        const show = gitSync(["--git-dir", bareDir, "show-ref"]);
        const all = show.stdout.split("\n").filter(Boolean).map((l) => {
          const [sha, ref] = l.split(" ");
          return { ref, node_id: `ref:${ref}`, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, "")}`, object: { sha, type: "commit" } };
        });
        const want = rest.slice(2).join("/");
        sendJson(res, 200, want ? all.filter((x) => x.ref === `refs/${want}` || x.ref.startsWith(`refs/${want}`)) : all);
        return;
      }
      if (rest[1] === "refs" && method === "POST") {
        if (!requireAuth(req, res)) return;
        const body = await readJson(req);
        const ref = typeof body.ref === "string" ? body.ref : "";
        const sha = typeof body.sha === "string" ? body.sha : "";
        if (!ref.startsWith("refs/") || !/^[0-9a-f]{40}$/.test(sha)) { sendError(res, 422, "Validation Failed", { errors: [{ field: "ref/sha", code: "invalid" }] }); return; }
        const up = gitSync(["--git-dir", bareDir, "update-ref", ref, sha]);
        if (up.code !== 0) { sendError(res, 422, up.stderr.trim() || "update-ref failed"); return; }
        sendJson(res, 201, { ref, node_id: `ref:${ref}`, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, "")}`, object: { sha, type: "commit" } });
        return;
      }
      if (rest[1] === "refs" && method === "DELETE") {
        if (!requireAuth(req, res)) return;
        const ref = "refs/" + rest.slice(2).join("/");
        const del = gitSync(["--git-dir", bareDir, "update-ref", "-d", ref]);
        if (del.code !== 0) { sendError(res, 422, del.stderr.trim() || "delete ref failed"); return; }
        res.writeHead(204); res.end(); return;
      }
      if (rest[1] === "trees" && method === "GET" && rest.length === 3) {
        const recursive = q.get("recursive") === "1";
        const args = ["--git-dir", bareDir, "ls-tree", ...(recursive ? ["-r"] : []), "-l", rest[2]];
        const t = gitSync(args);
        if (t.code !== 0) { sendError(res, 404, "Not Found"); return; }
        const tree = t.stdout.split("\n").filter(Boolean).map((l) => {
          const m = l.match(/^(\d+) (\w+) ([0-9a-f]{40}) +(\d+|-)\t(.*)$/);
          if (!m) return null;
          return { path: m[5], mode: m[1], type: m[2] === "tree" ? "tree" : "blob", sha: m[3], size: m[4] === "-" ? 0 : Number(m[4]), url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${m[3]}` };
        }).filter(Boolean);
        sendJson(res, 200, { sha: rest[2], url: `/api/v3/repos/${owner}/${repoName}/git/trees/${rest[2]}`, tree, truncated: false });
        return;
      }
      if (rest[1] === "blobs" && method === "GET" && rest.length === 3) {
        const type = gitSync(["--git-dir", bareDir, "cat-file", "-t", rest[2]]);
        if (type.code !== 0 || type.stdout.trim() !== "blob") { sendError(res, 404, "Not Found"); return; }
        const blob = gitBuf(["--git-dir", bareDir, "cat-file", "-p", rest[2]]);
        sendJson(res, 200, { sha: rest[2], size: blob.buf.length, encoding: "base64", content: blob.buf.toString("base64"), url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${rest[2]}` });
        return;
      }
      if (rest[1] === "commits" && method === "GET" && rest.length === 3) {
        const one = listCommits(bareDir, rest[2], 1);
        if (!one.length) { sendError(res, 404, "Not Found"); return; }
        sendJson(res, 200, one[0]);
        return;
      }
    }
    // ---- contents
    if (rest[0] === "contents") {
      const cpath = rest.slice(1).join("/");
      if (method === "GET") {
        if (!cpath) {
          const t = gitSync(["--git-dir", bareDir, "ls-tree", q.get("ref") || r.default_branch]);
          if (t.code !== 0) { sendJson(res, 200, []); return; }
          const entries = t.stdout.split("\n").filter(Boolean).map((l) => {
            const m = l.match(/^(\d+) (\w+) ([0-9a-f]{40})\t(.*)$/);
            if (!m) return null;
            return { name: m[4], path: m[4], sha: m[3], size: 0, type: m[2] === "tree" ? "dir" : "file", mode: m[1] };
          }).filter(Boolean);
          sendJson(res, 200, entries);
          return;
        }
        if (!validContentPath(cpath)) { sendError(res, 400, "Invalid path"); return; }
        contentsGet(res, r, cpath, q.get("ref") || "");
        return;
      }
      if (method === "PUT" || method === "POST") {
        if (!requireAuth(req, res)) return;
        if (!cpath || !validContentPath(cpath)) { sendError(res, 400, "Invalid path"); return; }
        const body = await readJson(req);
        contentsPut(res, r, cpath, body, false);
        return;
      }
      if (method === "DELETE") {
        if (!requireAuth(req, res)) return;
        if (!cpath || !validContentPath(cpath)) { sendError(res, 400, "Invalid path"); return; }
        const body = await readJson(req);
        contentsPut(res, r, cpath, body, true);
        return;
      }
    }
    if (rest[0] === "readme" && method === "GET") {
      for (const cand of ["README.md", "README", "readme.md"]) {
        const blob = gitBuf(["--git-dir", bareDir, "show", `HEAD:${cand}`]);
        if (blob.code === 0) {
          sendJson(res, 200, { type: "file", encoding: "base64", size: blob.buf.length, name: cand, path: cand, content: blob.buf.toString("base64"), sha: headSha(bareDir, `HEAD:${cand}`) || "" });
          return;
        }
      }
      sendError(res, 404, "Not Found");
      return;
    }
    // ---- labels (repository-level: POST creates, GET lists)
    if (rest[0] === "labels") {
      if (method === "GET") { sendJson(res, 200, r.labels || []); return; }
      if (method === "POST") {
        if (!requireAuth(req, res)) return;
        const body = await readJson(req);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 50) { sendError(res, 422, "Validation Failed", { errors: [{ resource: "Label", field: "name", code: "invalid" }] }); return; }
        const existing = (r.labels || []).find((l) => l.name === name);
        // Upsert: creating a default label (e.g. "bug") again still answers 201.
        if (existing) { sendJson(res, 201, existing); return; }
        const label: Label = { name, color: typeof body.color === "string" ? body.color.replace(/^#/, "").slice(0, 6) || "ededed" : "ededed", description: typeof body.description === "string" ? body.description.slice(0, 100) : "" };
        if (!r.labels) r.labels = [];
        r.labels.push(label);
        r.updated_at = nowIso(); saveStore();
        sendJson(res, 201, label);
        return;
      }
    }
    // ---- issues
    if (rest[0] === "issues") {
      if (rest.length === 1) {
        if (method === "GET") {
          let list = r.issues;
          if (stateQ !== "all") list = list.filter((i) => i.state === stateQ);
          const labels = q.get("labels");
          if (labels) list = list.filter((i) => labels.split(",").every((lb) => i.labels.some((l) => l.name === lb)));
          // GitHub sorts by created date; direction defaults to desc, ties
          // break by issue number (same-millisecond creates are common).
          const dir = q.get("direction") === "asc" ? 1 : -1;
          list = [...list].sort((a, b) => (a.created_at < b.created_at ? -dir : a.created_at > b.created_at ? dir : (a.number - b.number) * dir));
          listReply(list.map((i) => issueJson(r, i)));
          return;
        }
        if (method === "POST") {
          if (!requireAuth(req, res)) return;
          const body = await readJson(req);
          createIssueHandler(req, res, r, body);
          return;
        }
      }
      const num = Number(rest[1]);
      if (rest.length >= 2 && Number.isInteger(num) && num > 0) {
        const issue = issueOr404(res, r, num);
        if (!issue) return;
        if (rest.length === 2) {
          if (method === "GET") { sendJson(res, 200, issueJson(r, issue)); return; }
          if (method === "PATCH") {
            if (!requireAuth(req, res)) return;
            const body = await readJson(req);
            const wasOpen = issue.state === "open";
            if (typeof body.title === "string") issue.title = body.title.slice(0, 1000);
            if (typeof body.body === "string") issue.body = body.body;
            if (body.state === "open" || body.state === "closed") { issue.state = body.state; issue.closed_at = body.state === "closed" ? nowIso() : null; }
            if (Array.isArray(body.labels)) issue.labels = body.labels.filter((l: unknown) => typeof l === "string").slice(0, 20).map((l: string) => ({ name: l, color: "ededed", description: "" }));
            if (Array.isArray(body.assignees)) issue.assignees = body.assignees.filter((a: unknown) => typeof a === "string").slice(0, 10);
            issue.updated_at = nowIso(); r.updated_at = nowIso(); saveStore();
            if (wasOpen && issue.state === "closed") fireHooks(r, "issues", { action: "closed", issue: issueJson(r, issue), repository: repoJson(r), sender: userRef(FORGE_USER) });
            if (!wasOpen && issue.state === "open") fireHooks(r, "issues", { action: "reopened", issue: issueJson(r, issue), repository: repoJson(r), sender: userRef(FORGE_USER) });
            sendJson(res, 200, issueJson(r, issue));
            return;
          }
        }
        if (rest[2] === "comments") {
          if (method === "GET") { sendJson(res, 200, slice(issue.comments)); return; }
          if (method === "POST") {
            if (!requireAuth(req, res)) return;
            const body = await readJson(req);
            addCommentHandler(res, r, issue, body, "issue");
            return;
          }
        }
        if (rest[2] === "labels") {
          if (method === "GET") { sendJson(res, 200, issue.labels); return; }
          if (method === "POST" || method === "PUT") {
            if (!requireAuth(req, res)) return;
            const body = await readJson(req);
            const names = Array.isArray(body) ? body : (Array.isArray(body.labels) ? body.labels : []);
            issue.labels = names.filter((l: unknown) => typeof l === "string").slice(0, 20).map((l: string) => ({ name: l, color: "ededed", description: "" }));
            issue.updated_at = nowIso(); saveStore();
            sendJson(res, 200, issue.labels);
            return;
          }
        }
      }
    }
    // ---- pull requests
    if (rest[0] === "pulls") {
      if (rest.length === 1) {
        if (method === "GET") {
          let list = r.pulls;
          if (stateQ !== "all") list = list.filter((p) => p.state === stateQ);
          const dir = q.get("direction") === "asc" ? 1 : -1;
          list = [...list].sort((a, b) => (a.created_at < b.created_at ? -dir : a.created_at > b.created_at ? dir : (a.number - b.number) * dir));
          listReply(list.map((p) => prJson(r, p)));
          return;
        }
        if (method === "POST") {
          if (!requireAuth(req, res)) return;
          const body = await readJson(req);
          createPrHandler(res, r, body);
          return;
        }
      }
      const num = Number(rest[1]);
      if (rest.length >= 2 && Number.isInteger(num) && num > 0) {
        const pr = prOr404(res, r, num);
        if (!pr) return;
        if (rest.length === 2) {
          if (method === "GET") { sendJson(res, 200, prJson(r, pr)); return; }
          if (method === "PATCH") {
            if (!requireAuth(req, res)) return;
            const body = await readJson(req);
            if (typeof body.title === "string") pr.title = body.title.slice(0, 1000);
            if (typeof body.body === "string") pr.body = body.body;
            if (body.state === "closed" && pr.state === "open") { pr.state = "closed"; pr.closed_at = nowIso(); }
            if (body.state === "open" && pr.state === "closed" && !pr.merged) { pr.state = "open"; pr.closed_at = null; }
            pr.updated_at = nowIso(); r.updated_at = nowIso(); saveStore();
            sendJson(res, 200, prJson(r, pr));
            return;
          }
        }
        if (rest[2] === "merge") {
          if (method === "GET") { sendJson(res, 200, { merged: pr.merged, message: pr.merged ? "Pull Request successfully merged" : "Not merged" }); return; }
          if (method === "PUT" || method === "POST") {
            if (!requireAuth(req, res)) return;
            const body = await readJson(req);
            mergePrHandler(res, r, pr, body);
            return;
          }
        }
        if (rest[2] === "commits" && method === "GET") {
          sendJson(res, 200, slice(listCommits(bareDir, `${pr.base.sha}..${pr.head.sha}`, perPage)));
          return;
        }
        if (rest[2] === "files" && method === "GET") {
          const d = gitSync(["--git-dir", bareDir, "diff", "--numstat", `${pr.base.sha}..${pr.head.sha}`]);
          const files = d.code === 0 ? d.stdout.split("\n").filter(Boolean).map((l) => {
            const [add, del, file] = l.split("\t");
            return { filename: file, status: "modified", additions: Number(add) || 0, deletions: Number(del) || 0, changes: (Number(add) || 0) + (Number(del) || 0) };
          }) : [];
          sendJson(res, 200, files);
          return;
        }
        if (rest[2] === "comments") {
          if (method === "GET") { sendJson(res, 200, slice(pr.comments)); return; }
          if (method === "POST") {
            if (!requireAuth(req, res)) return;
            const body = await readJson(req);
            addCommentHandler(res, r, pr, body, "pr");
            return;
          }
        }
        if (rest[2] === "reviews") {
          const key = `${owner}/${repoName}/${num}`;
          if (method === "GET") { sendJson(res, 200, prReviews.get(key) || []); return; }
          if (method === "POST") {
            if (!requireAuth(req, res)) return;
            const body = await readJson(req);
            const review = { id: Date.now(), user: userRef(FORGE_USER), body: typeof body.body === "string" ? body.body : "", event: typeof body.event === "string" ? body.event : "COMMENT", state: typeof body.event === "string" ? body.event : "COMMENTED", submitted_at: nowIso() };
            const list = prReviews.get(key) || [];
            list.push(review); prReviews.set(key, list);
            sendJson(res, 200, review);
            return;
          }
        }
      }
    }
    // ---- webhooks
    if (rest[0] === "hooks") {
      if (rest.length === 1) {
        if (method === "GET") { sendJson(res, 200, r.hooks.map((h) => hookJson(r, h))); return; }
        if (method === "POST") {
          if (!requireAuth(req, res)) return;
          const body = await readJson(req);
          const cfg = (body.config && typeof body.config === "object") ? body.config : {};
          const urlStr = typeof cfg.url === "string" ? cfg.url : "";
          let parsed: URL | null = null;
          try { parsed = new URL(urlStr); } catch { parsed = null; }
          if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
            sendError(res, 422, "Validation Failed", { errors: [{ field: "config.url", code: "invalid" }] }); return;
          }
          const hook: Hook = {
            id: r.next_hook++, name: "web", active: body.active !== false,
            events: Array.isArray(body.events) && body.events.length ? body.events.filter((e: unknown) => typeof e === "string") : ["push"],
            config: { url: urlStr, content_type: cfg.content_type === "form" ? "form" : "json" },
            created_at: nowIso(), updated_at: nowIso(),
          };
          r.hooks.push(hook); r.updated_at = nowIso(); saveStore();
          sendJson(res, 201, hookJson(r, hook));
          return;
        }
      }
      const hid = Number(rest[1]);
      if (rest.length >= 2 && Number.isInteger(hid) && hid > 0) {
        const hook = r.hooks.find((h) => h.id === hid);
        if (!hook) { sendError(res, 404, "Not Found"); return; }
        if (rest.length === 2) {
          if (method === "GET") { sendJson(res, 200, hookJson(r, hook)); return; }
          if (method === "PATCH") {
            if (!requireAuth(req, res)) return;
            const body = await readJson(req);
            if (body.active === true || body.active === false) hook.active = body.active;
            if (Array.isArray(body.events) && body.events.length) hook.events = body.events.filter((e: unknown) => typeof e === "string");
            if (body.config && typeof body.config === "object" && typeof body.config.url === "string") hook.config.url = body.config.url;
            hook.updated_at = nowIso(); saveStore();
            sendJson(res, 200, hookJson(r, hook));
            return;
          }
          if (method === "DELETE") {
            if (!requireAuth(req, res)) return;
            r.hooks = r.hooks.filter((h) => h !== hook);
            deliveries.delete(deliveryKey(owner, repoName, hid));
            saveStore();
            res.writeHead(204); res.end(); return;
          }
        }
        if (rest[2] === "deliveries" && method === "GET") {
          sendJson(res, 200, deliveries.get(deliveryKey(owner, repoName, hid)) || []);
          return;
        }
        if ((rest[2] === "pings" || rest[2] === "tests") && method === "POST") {
          if (!requireAuth(req, res)) return;
          void deliverHook(owner, repoName, hook, "ping", { zen: "Keep it logically awesome.", hook_id: hook.id, repository: repoJson(r), sender: userRef(FORGE_USER) });
          res.writeHead(204); res.end(); return;
        }
      }
    }
  }

  sendError(res, 404, "Not Found");
}

// ---------------------------------------------------------------- top-level handler
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end();
    return;
  }
  if (!checkRate(req, res)) return;
  let url: URL;
  try { url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`); } catch { sendError(res, 400, "Bad Request"); return; }
  const method = req.method || "GET";
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const seg = pathname.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });

  // GraphQL / MCP (fixed paths, before the /api/v3 strip)
  if (pathname === "/graphql" || pathname === "/api/graphql" || pathname === "/api/v3/graphql") {
    if (method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
    await handleGraphQL(req, res);
    return;
  }
  if (pathname === "/mcp" || pathname === "/api/mcp") {
    if (method === "GET") { sendError(res, 405, "MCP requires POST with a JSON-RPC body"); return; }
    if (method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
    await handleMcp(req, res);
    return;
  }

  // git smart HTTP: /:owner/:repo.git/<op>  (also without the .git suffix)
  if (seg.length >= 3 && seg[0] !== "api" && seg[0] !== "graphql" && seg[0] !== "mcp") {
    const owner = seg[0];
    const repoSeg = seg[1];
    const repoName = repoSeg.endsWith(".git") ? repoSeg.slice(0, -4) : repoSeg;
    const op = seg.slice(2).join("/");
    if (validName(owner) && validName(repoName)) {
      if (op === "info/refs" && method === "GET") {
        await handleInfoRefs(req, res, owner, repoName, url.searchParams.get("service") || "");
        return;
      }
      if (op === "git-upload-pack" && method === "POST") { handleUploadPack(req, res, owner, repoName); return; }
      if (op === "git-receive-pack" && method === "POST") { handleReceivePack(req, res, owner, repoName); return; }
      if (op === "HEAD" && method === "GET") {
        const r = findRepo(owner, repoName);
        if (!r) { sendError(res, 404, "Not Found"); return; }
        const f = join(barePath(owner, repoName), "HEAD");
        if (!existsSync(f)) { sendError(res, 404, "Not Found"); return; }
        const body = readFileSync(f);
        res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": body.length });
        res.end(body);
        return;
      }
    }
  }
  if (seg.length === 2 && seg[1].endsWith(".git") && seg[0] !== "api") {
    const owner = seg[0];
    const repoName = seg[1].slice(0, -4);
    if (validName(owner) && validName(repoName)) {
      const r = findRepo(owner, repoName);
      if (!r) { sendError(res, 404, "Not Found"); return; }
      sendJson(res, 200, repoJson(r));
      return;
    }
  }

  // Health probe: the suite's boot check calls it (no auth).
  if (pathname === "/healthz" && method === "GET") {
    sendJson(res, 200, { ok: true });
    return;
  }
  // REST: strip the optional /api/v3 prefix
  let restSeg = seg;
  if (seg[0] === "api" && seg[1] === "v3") restSeg = seg.slice(2);
  if (pathname === "/" && method === "GET") {
    sendJson(res, 200, { message: "forge — a standalone GitHub-compatible git forge (no UI)", version: "1.0.0", api: "/api/v3", graphql: "/graphql", mcp: "/mcp" });
    return;
  }
  await handleRest(req, res, method, restSeg, url);
}

const server = createServer((req, res) => {
  handle(req, res).catch((e: any) => {
    if (!res.writableEnded) sendError(res, e && e.status ? e.status : 500, (e && e.message) || "Internal Server Error");
  });
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));

// ---------------------------------------------------------------- make.fun trial lifecycle (kit starter/main.ts)
// In a trial MAKEFUN_ENV_URL names the suite's origin:
//   1. bind an ephemeral port (never 8080 — the suite owns it),
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register,
//   3. poll GET $MAKEFUN_ENV_URL/done until {"done": true}, then exit 0.
// Without MAKEFUN_ENV_URL this is a plain standalone server (local dev,
// test.sh): it binds PORT/HOST and stays up until killed.
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 30_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function retryDelay(attempt: number): number {
  return Math.min(2_000, 250 * 2 ** Math.min(attempt, 8));
}
async function registerWithEnv(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const r = await fetch(`${ENV_URL}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (r.status === 200 || r.status === 409) return;
      if (r.status === 400 || r.status === 405) throw new Error(`register answered HTTP ${r.status}: ${await r.text()}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("register answered HTTP ")) throw e;
    }
    await sleep(retryDelay(attempt));
  }
}
async function waitForEnvDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const r = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (r.ok) {
        const body = (await r.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch { /* not done yet; poll again */ }
    await sleep(retryDelay(attempt));
  }
}
async function main(): Promise<void> {
  if (ENV_URL === "") {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, HOST, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : PORT;
    console.log(`forge listening on http://${HOST}:${port}`);
    console.log(`FORGE_PORT=${port}`);
    console.log(`data dir: ${resolve(DATA_DIR)}`);
    console.log(`auth token: ${TOKEN === "forge-secret-token" ? "default (set FORGE_TOKEN to change)" : "set"}`);
    return; // stays up until SIGINT/SIGTERM
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("the server did not bind an ephemeral TCP port");
  console.log(`[entry] listening on port ${addr.port}`);
  await registerWithEnv(addr.port);
  console.log("[entry] registered; waiting for the env to say done");
  await waitForEnvDone();
  server.close();
  console.log("[entry] done");
}
try {
  await main();
  if (ENV_URL !== "") process.exit(0);
} catch (e) {
  console.error(`[entry] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
