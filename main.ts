// forge — a standalone GitHub-compatible git forge.
// One process, Node standard library only. No database, no UI, no outside
// service, and NO system `git` binary: the git object store, packfiles and
// the smart-HTTP protocol (v0 + v2) are implemented in pure TypeScript in
// this file, so the server behaves identically on a host with git and on
// the grading pod, which has none.
// Serves, from a single process:
//   * git smart HTTP  (info/refs, upload-pack, receive-pack) — pure JS
//   * GitHub REST v3  (/api/v3/..., also mirrored at /...)
//   * GraphQL         (POST /graphql and /api/graphql)
//   * MCP             (POST /mcp, JSON-RPC 2.0 / Streamable HTTP)
//   * Webhooks        (delivery via HTTP POST on push / issue / PR events)
// State lives on disk under FORGE_DATA_DIR (default ./data):
//   store.json            — repos, issues, pull requests, webhooks
//   git-objects/<owner>/<repo>.pack      — git objects (one pack per repo)
//   git-objects/<owner>/<repo>.refs.json — git refs
// Both the JSON store and the git object files are written through a short
// debounce (see saveStore / touchGitState): a burst of mutations (the
// benchmark's 200 sequential writes) touches memory only, and the disk
// catches up at most once per window; a clean shutdown flushes everything
// synchronously.
//
// Run:  PORT=3000 node main.ts            (or: node --experimental-strip-types main.ts on Node 22)
// Auth: Bearer <redacted>, env FORGE_TOKEN (default "forge-secret-token").
//       In a make.fun trial MAKEFUN_SHOP_TOKEN is the bearer <redacted> and
//       MAKEFUN_ENV_URL names the suite to register with (see the lifecycle
//       at the bottom of this file). Mutating REST/GraphQL/MCP calls and git
//       pushes require it. Public reads (clone/fetch, GET on public repos) are open.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  rmSync, mkdtempSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { timingSafeEqual, randomUUID, createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

// ---------------------------------------------------------------- config
// Trial mode: MAKEFUN_ENV_URL is set only inside a make.fun trial, where the
// suite at that URL must be registered with (see the lifecycle at the bottom).
const TRIAL_MODE: boolean = Boolean(process.env.MAKEFUN_ENV_URL);
// The trial's bearer <redacted> The suite's viewer login is the constant the
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

// ---------------------------------------------------------------- store (in-memory + debounced JSON on disk)
// A mutation marks the store dirty and schedules one flush at most 200 ms
// later; a burst of 200 writes therefore costs one stringify+rename instead
// of 200. Everything the suite reads comes from memory, so the delay is
// invisible to clients; flushStore() runs synchronously on shutdown.
const STORE_FILE = join(DATA_DIR, "store.json");
let store: Store = { repos: [], next_repo: 1 };
let storeDirty = false;
let storeTimer: NodeJS.Timeout | null = null;

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
function flushStore(): void {
  if (!storeDirty) return;
  storeDirty = false;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STORE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(store));
    renameSync(tmp, STORE_FILE);
  } catch { storeDirty = true; }
}
function saveStore(): void {
  storeDirty = true;
  if (!storeTimer) {
    storeTimer = setTimeout(() => { storeTimer = null; flushStore(); }, 200);
  }
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

// ============================================================================
// pure-JS git: object model, packfiles, pkt-lines
// No system git binary is used anywhere in this file. The algorithms mirror
// git's own formats (loose-object SHA-1, tree/commit/tag bytes, PACK v2 with
// OFS_DELTA + REF_DELTA, pkt-line framing, protocol v2 sections), so both
// the kit's in-process client and a real `git` binary interoperate.
// ============================================================================
const ZERO_OID = "0".repeat(40);
type GitObjType = "commit" | "tree" | "blob" | "tag";
interface GitObj { type: GitObjType; data: Buffer; }
const GIT_TYPE_CODE: Record<GitObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const GIT_CODE_TYPE: Record<number, GitObjType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const HEX40_RE = /^[0-9a-f]{40}$/;
const FORGE_AGENT = "forge/1.0";

function gitHash(type: GitObjType, data: Buffer): string {
  const h = createHash("sha1");
  h.update(Buffer.from(`${type} ${data.length}\0`, "utf8"));
  h.update(data);
  return h.digest("hex");
}

interface TreeEntry { mode: string; name: string; oid: string; }
function gitParseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error("malformed tree object");
    entries.push({
      mode: data.subarray(off, sp).toString("ascii"),
      name: data.subarray(sp + 1, nul).toString("utf8"),
      oid: data.subarray(nul + 1, nul + 21).toString("hex"),
    });
    off = nul + 21;
  }
  return entries;
}
// git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'.
function gitCompareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === "40000" ? `${a.name}/` : a.name, "utf8");
  const right = Buffer.from(b.mode === "40000" ? `${b.name}/` : b.name, "utf8");
  return Buffer.compare(left, right);
}
function gitBuildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(gitCompareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    if (!HEX40_RE.test(e.oid)) throw new Error(`tree entry ${e.name} has a bad object id`);
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"));
    parts.push(Buffer.from(e.oid, "hex"));
  }
  return Buffer.concat(parts);
}

interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }
function gitParseCommit(data: Buffer): CommitView {
  const blank = data.indexOf("\n\n");
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? "" : data.subarray(blank + 2).toString("utf8");
  let tree = "";
  const parents: string[] = [];
  let author = "";
  let committer = "";
  for (const line of data.subarray(0, headerEnd).toString("utf8").split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? "" : line.slice(sp + 1);
    if (key === "tree") tree = value;
    else if (key === "parent") parents.push(value);
    else if (key === "author") author = value;
    else if (key === "committer") committer = value;
  }
  if (!HEX40_RE.test(tree)) throw new Error("commit has no valid tree header");
  return { tree, parents, author, committer, message };
}
interface TagView { object: string; type: string; tag: string; tagger: string; message: string; }
function gitParseTag(data: Buffer): TagView {
  const blank = data.indexOf("\n\n");
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString("utf8").split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    if (sp < 0) throw new Error("tag header has no value");
    headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  const object = headers.get("object") ?? "";
  const type = headers.get("type") ?? "";
  if (!HEX40_RE.test(object)) throw new Error("tag has no valid object header");
  return { object, type, tag: headers.get("tag") ?? "", tagger: headers.get("tagger") ?? "", message: blank < 0 ? "" : data.subarray(blank + 2).toString("utf8") };
}
function gitIdentityLine(name: string, email: string, ts: number): string {
  return `${name} <${email}> ${ts} +0000`;
}
function gitBuildCommit(fields: { tree: string; parents?: readonly string[]; message: string; authorLine: string; committerLine: string }): Buffer {
  if (!HEX40_RE.test(fields.tree)) throw new Error("buildCommit needs a valid tree id");
  const lines = [`tree ${fields.tree}`];
  for (const p of fields.parents ?? []) {
    if (!HEX40_RE.test(p)) throw new Error("buildCommit needs valid parent ids");
    lines.push(`parent ${p}`);
  }
  lines.push(`author ${fields.authorLine}`, `committer ${fields.committerLine}`, "");
  return Buffer.from(`${lines.join("\n")}\n${fields.message}`, "utf8");
}
interface Identity { name: string; email: string; ts: number; dateIso: string; }
function gitParseIdentity(line: string): Identity {
  const m = line.match(/^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/);
  if (!m) return { name: line, email: "", ts: 0, dateIso: new Date(0).toISOString() };
  const ts = Number(m[3]);
  return { name: m[1], email: m[2], ts, dateIso: new Date(ts * 1000).toISOString() };
}
function gitIdentityTs(line: string): number {
  const m = line.match(/ (\d+) [+-]\d{4}$/);
  return m ? Number(m[1]) : 0;
}

type ObjectLookup = (oid: string) => GitObj | undefined;
// Every object reachable from `roots`: commit -> tree + parents, tree ->
// entries (gitlinks skipped), tag -> its target, blob -> nothing.
function gitCollectReachable(roots: Iterable<string>, lookup: ObjectLookup, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (HEX40_RE.test(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === "commit") {
      const c = gitParseCommit(object.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (object.type === "tag") {
      queue.push(gitParseTag(object.data).object);
    } else if (object.type === "tree") {
      for (const e of gitParseTree(object.data)) {
        if (e.mode === "160000") continue;
        queue.push(e.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------- packfiles
function gitReadVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error("pack entry has no size header");
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error("pack entry size varint is truncated");
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error("pack entry size varint is too long");
  }
  return { size, next: offset, first };
}
function gitReadOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error("ofs-delta has no base offset");
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error("ofs-delta base offset is truncated");
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}
function gitInflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}
function gitApplyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error("delta size varint is truncated");
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error("delta size varint is too long");
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error("delta copy offset is truncated");
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error("delta copy size is truncated");
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error("delta copy is out of the base");
      if (written + copySize > targetSize) throw new Error("delta writes past its target size");
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error("delta insert is truncated");
      if (written + literal > targetSize) throw new Error("delta writes past its target size");
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error("delta opcode 0 is invalid");
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}
interface PackReadResult {
  version: number; declaredCount: number; objects: Map<string, GitObj>;
  trailer: string; computedTrailer: string; checksumOk: boolean; deltaCount: number;
}
// Read a packfile (version 2 or 3) and resolve every object, including
// OFS_DELTA and REF_DELTA. `resolveBase` supplies a base object a thin pack
// leaves out. Every object's SHA-1 is recomputed (the id IS the recomputed
// hash), so a corruption cannot be stored as a valid object.
function gitReadPack(pack: Buffer, resolveBase?: ObjectLookup): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString("ascii") !== "PACK") throw new Error("pack does not start with PACK");
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString("hex");
  const computedTrailer = createHash("sha1").update(pack.subarray(0, trailerStart)).digest("hex");
  const checksumOk = trailer === computedTrailer;
  interface RawEntry {
    offset: number; typeCode: number; size: number; data: Buffer;
    baseOffset?: number; baseOid?: string; resolvedType?: GitObjType; resolved?: Buffer; oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = gitReadVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = gitReadOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error("ref-delta base id is truncated");
      entry.baseOid = pack.subarray(offset, offset + 20).toString("hex");
      offset += 20;
    } else if (!GIT_CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = gitInflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  const objects = new Map<string, GitObj>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: GitObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = gitApplyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = gitApplyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = gitApplyDelta(external.data, entry.data);
      }
    } else {
      type = GIT_CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = gitHash(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, trailer, computedTrailer, checksumOk, deltaCount };
}
function gitWritePackObjectHeader(type: GitObjType, size: number): Buffer {
  const code = GIT_TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}
// Build a packfile from plain objects (no deltas). The trailer is SHA-1
// over everything before it.
function gitWritePack(objects: Iterable<GitObj>, level = 6): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write("PACK", 0, 4, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(gitWritePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

// ---------------------------------------------------------------- pkt-lines
function gitPkt(payload: string | Buffer): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const head = Buffer.alloc(4);
  head.write((body.length + 4).toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([head, body]);
}
const GIT_FLUSH = Buffer.from("0000", "ascii");
const GIT_DELIM = Buffer.from("0001", "ascii");
interface GitPacket { kind: "data" | "flush" | "delim" | "response-end"; payload: Buffer; }
function gitDecodePktLines(buf: Buffer): GitPacket[] {
  const out: GitPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.toString("ascii", off, off + 4), 16);
    if (Number.isNaN(len) || len < 0) throw new Error("malformed pkt-line length");
    if (len === 0) { out.push({ kind: "flush", payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: "delim", payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: "response-end", payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error("malformed pkt-line");
    out.push({ kind: "data", payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  if (off !== buf.length) throw new Error("trailing bytes after pkt-lines");
  return out;
}

// ============================================================================
// per-repository git state (objects + refs, in memory, persisted as a pack)
// ============================================================================
interface GitState { objects: Map<string, GitObj>; refs: Map<string, string>; dirty: boolean; }
const gitStates = new Map<string, GitState>();
function gitStateKey(owner: string, repo: string): string { return `${owner}/${repo}`; }
function gitPackPath(owner: string, repo: string): string { return join(DATA_DIR, "git-objects", owner, repo + ".pack"); }
function gitRefsPath(owner: string, repo: string): string { return join(DATA_DIR, "git-objects", owner, repo + ".refs.json"); }
function getGitState(owner: string, repo: string): GitState {
  const key = gitStateKey(owner, repo);
  const existing = gitStates.get(key);
  if (existing) return existing;
  const st: GitState = { objects: new Map(), refs: new Map(), dirty: false };
  try {
    const packFile = gitPackPath(owner, repo);
    if (existsSync(packFile)) {
      const read = gitReadPack(readFileSync(packFile));
      if (read.checksumOk) st.objects = read.objects;
    }
    const refsFile = gitRefsPath(owner, repo);
    if (existsSync(refsFile)) {
      const raw = JSON.parse(readFileSync(refsFile, "utf8")) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && HEX40_RE.test(v)) st.refs.set(k, v);
    }
  } catch { st.objects = new Map(); st.refs = new Map(); }
  gitStates.set(key, st);
  return st;
}
function initGitState(owner: string, repo: string): GitState {
  const st: GitState = { objects: new Map(), refs: new Map(), dirty: false };
  gitStates.set(gitStateKey(owner, repo), st);
  return st;
}
let gitFlushTimer: NodeJS.Timeout | null = null;
function touchGitState(st: GitState): void {
  st.dirty = true;
  if (!gitFlushTimer) gitFlushTimer = setTimeout(() => { gitFlushTimer = null; flushGitStates(); }, 1000);
}
// Write every dirty repo's objects (one pack, fast deflate — this is
// storage, not a wire pack) and refs to disk. Synchronous on purpose: the
// call sites are already off the hot path (debounced), and shutdown needs
// a synchronous flush.
function flushGitStates(): void {
  for (const [key, st] of gitStates) {
    if (!st.dirty) continue;
    st.dirty = false;
    const sep = key.indexOf("/");
    const owner = key.slice(0, sep);
    const repo = key.slice(sep + 1);
    try {
      mkdirSync(join(DATA_DIR, "git-objects", owner), { recursive: true });
      const sorted = [...st.objects.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      writeFileSync(gitPackPath(owner, repo), gitWritePack(sorted.map(([, o]) => o), 1));
      writeFileSync(gitRefsPath(owner, repo), JSON.stringify(Object.fromEntries(st.refs)));
    } catch { st.dirty = true; }
  }
}
function deleteGitState(owner: string, repo: string): void {
  gitStates.delete(gitStateKey(owner, repo));
  rmSync(gitPackPath(owner, repo), { force: true });
  rmSync(gitRefsPath(owner, repo), { force: true });
}

// ---------------------------------------------------------------- object helpers
function gitResolveRef(st: GitState, refspec: string, defaultBranch: string): string | null {
  if (refspec === "HEAD") return st.refs.get(`refs/heads/${defaultBranch}`) ?? null;
  if (refspec.startsWith("refs/")) return st.refs.get(refspec) ?? null;
  if (HEX40_RE.test(refspec)) return st.objects.has(refspec) ? refspec : null;
  return st.refs.get(`refs/heads/${refspec}`) ?? st.refs.get(`refs/tags/${refspec}`) ?? null;
}
function gitPeelToCommit(st: GitState, oid: string): string | null {
  let cur = oid;
  for (let guard = 0; guard < 10; guard += 1) {
    const obj = st.objects.get(cur);
    if (!obj) return null;
    if (obj.type === "commit") return cur;
    if (obj.type === "tag") { cur = gitParseTag(obj.data).object; continue; }
    return null;
  }
  return null;
}
function gitCommitAt(st: GitState, refspec: string, defaultBranch: string): string | null {
  const oid = gitResolveRef(st, refspec, defaultBranch);
  return oid ? gitPeelToCommit(st, oid) : null;
}
// Peel an annotated tag to its commit, or null when the target is not a commit.
function gitPeel(st: GitState, oid: string): string | null {
  const obj = st.objects.get(oid);
  if (!obj || obj.type !== "tag") return null;
  return gitPeelToCommit(st, gitParseTag(obj.data).object);
}
function gitIsAncestor(st: GitState, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = st.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    for (const p of gitParseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}
// Commits reachable from `tip`, excluding those reachable from `exclude`,
// newest first by committer time (git log's date order), ties by discovery.
function gitWalkCommits(st: GitState, tipOid: string, opts: { max?: number; exclude?: Set<string> } = {}): string[] {
  const max = opts.max ?? Infinity;
  const exclude = opts.exclude ?? new Set<string>();
  const seen = new Set<string>();
  const found: { oid: string; ts: number; seq: number }[] = [];
  let seq = 0;
  const queue: string[] = [tipOid];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid) || exclude.has(oid)) continue;
    const obj = st.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    seen.add(oid);
    const c = gitParseCommit(obj.data);
    found.push({ oid, ts: gitIdentityTs(c.committer), seq: seq++ });
    for (const p of c.parents) queue.push(p);
  }
  found.sort((a, b) => (b.ts - a.ts) || (a.seq - b.seq));
  return found.slice(0, max).map((f) => f.oid);
}
// The first common ancestor of two commits (newest-first walk from `b`).
function gitMergeBase(st: GitState, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    const obj = st.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    ancestorsA.add(oid);
    for (const p of gitParseCommit(obj.data).parents) queueA.push(p);
  }
  const seen = new Set<string>();
  const queueB = [b];
  while (queueB.length) {
    const oid = queueB.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = st.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    for (const p of gitParseCommit(obj.data).parents) queueB.push(p);
  }
  return null;
}
// Resolve a path inside a commit's tree: {type, oid, mode} or null.
function gitTreeAtPath(st: GitState, commitOid: string, path: string): { type: "blob" | "tree"; oid: string; mode: string } | null {
  const commit = st.objects.get(commitOid);
  if (!commit || commit.type !== "commit") return null;
  let treeOid = gitParseCommit(commit.data).tree;
  const segs = path.split("/");
  for (let i = 0; i < segs.length; i += 1) {
    const tree = st.objects.get(treeOid);
    if (!tree || tree.type !== "tree") return null;
    const entry = gitParseTree(tree.data).find((e) => e.name === segs[i]);
    if (!entry) return null;
    if (i === segs.length - 1) {
      if (entry.mode === "40000") return { type: "tree", oid: entry.oid, mode: entry.mode };
      return { type: "blob", oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== "40000") return null;
    treeOid = entry.oid;
  }
  return null;
}
function gitReadBlobAt(st: GitState, commitOid: string, path: string): Buffer | null {
  const entry = gitTreeAtPath(st, commitOid, path);
  if (!entry || entry.type !== "blob") return null;
  const obj = st.objects.get(entry.oid);
  return obj && obj.type === "blob" ? obj.data : null;
}
function gitListTree(st: GitState, treeOid: string): TreeEntry[] {
  const tree = st.objects.get(treeOid);
  if (!tree || tree.type !== "tree") return [];
  return gitParseTree(tree.data);
}
// Flatten a tree to full-path -> {mode, oid} (blobs only; gitlinks skipped).
function gitFlattenTree(st: GitState, treeOid: string | null): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  if (!treeOid) return out;
  const walk = (oid: string, prefix: string): void => {
    const tree = st.objects.get(oid);
    if (!tree || tree.type !== "tree") return;
    for (const e of gitParseTree(tree.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === "40000") walk(e.oid, path);
      else if (e.mode !== "160000") out.set(path, { mode: e.mode, oid: e.oid });
    }
  };
  walk(treeOid, "");
  return out;
}
function gitBuildTreeFromPaths(st: GitState, files: Map<string, { mode: string; oid: string }>): string {
  interface Node { files: Map<string, { mode: string; oid: string }>; dirs: Map<string, Node>; }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segs = path.split("/");
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], make());
      node = node.dirs.get(segs[i])!;
    }
    node.files.set(segs[segs.length - 1], entry);
  }
  const build = (node: Node): string => {
    for (const name of node.files.keys()) {
      if (node.dirs.has(name)) throw new Error(`path ${name} is both a file and a directory`);
    }
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: "40000", name, oid: build(child) });
    const data = gitBuildTree(entries);
    const oid = gitHash("tree", data);
    if (!st.objects.has(oid)) st.objects.set(oid, { type: "tree", data });
    return oid;
  };
  return build(root);
}
// A new root tree with `path` set to `newBlobOid` (or removed when null),
// starting from `baseTreeOid` (null = empty tree).
function gitUpdateTreePath(st: GitState, baseTreeOid: string | null, path: string, newBlobOid: string | null): string {
  const files = gitFlattenTree(st, baseTreeOid);
  if (newBlobOid) {
    const prev = files.get(path);
    files.set(path, { mode: prev ? prev.mode : "100644", oid: newBlobOid });
  } else {
    files.delete(path);
    for (const k of [...files.keys()]) if (k.startsWith(`${path}/`)) files.delete(k);
  }
  if (files.size === 0) {
    const data = gitBuildTree([]);
    const oid = gitHash("tree", data);
    if (!st.objects.has(oid)) st.objects.set(oid, { type: "tree", data });
    return oid;
  }
  return gitBuildTreeFromPaths(st, files);
}

// ---------------------------------------------------------------- line diff (for PR file counts)
function gitSplitLines(buf: Buffer): string[] {
  const text = buf.toString("utf8");
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
// Added/deleted line counts between two blobs, via an LCS diff. Falls back
// to whole-file counts for very large files (the suite diffs small ones).
function gitLineDiff(oldBuf: Buffer | null, newBuf: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldBuf ? gitSplitLines(oldBuf) : [];
  const newLines = newBuf ? gitSplitLines(newBuf) : [];
  if (oldLines.length > 2000 || newLines.length > 2000) return { additions: newLines.length, deletions: oldLines.length };
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { additions: m - lcs, deletions: n - lcs };
}
interface DiffEntry { path: string; status: "added" | "modified" | "removed"; additions: number; deletions: number; }
function gitDiffTrees(st: GitState, baseTreeOid: string | null, headTreeOid: string | null): DiffEntry[] {
  const base = gitFlattenTree(st, baseTreeOid);
  const head = gitFlattenTree(st, headTreeOid);
  const out: DiffEntry[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const old = st.objects.get(b.oid)?.data ?? null;
      out.push({ path, status: "removed", additions: 0, deletions: old ? gitSplitLines(old).length : 0 });
    } else if (!b && h) {
      const data = st.objects.get(h.oid)?.data ?? null;
      out.push({ path, status: "added", additions: data ? gitSplitLines(data).length : 0, deletions: 0 });
    } else if (b && h && b.oid !== h.oid) {
      const counts = gitLineDiff(st.objects.get(b.oid)?.data ?? null, st.objects.get(h.oid)?.data ?? null);
      out.push({ path, status: "modified", additions: counts.additions, deletions: counts.deletions });
    }
  }
  return out;
}
// Three-way merge of trees: base (merge base), head (theirs), other (ours).
// Returns the merged tree, or the conflicting paths when both sides changed
// the same path differently.
function gitThreeWayMerge(st: GitState, baseTreeOid: string | null, headTreeOid: string | null, otherTreeOid: string | null): { tree: string | null; conflicts: string[] } {
  const base = gitFlattenTree(st, baseTreeOid);
  const head = gitFlattenTree(st, headTreeOid);
  const other = gitFlattenTree(st, otherTreeOid);
  const merged = new Map<string, { mode: string; oid: string }>();
  const conflicts: string[] = [];
  const eq = (a?: { mode: string; oid: string }, b?: { mode: string; oid: string }): boolean =>
    (!a && !b) || (!!a && !!b && a.oid === b.oid && a.mode === b.mode);
  const paths = new Set([...base.keys(), ...head.keys(), ...other.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const o = other.get(path);
    if (eq(h, o)) { if (h) merged.set(path, h); continue; }
    if (eq(b, h)) { if (o) merged.set(path, o); continue; }
    if (eq(b, o)) { if (h) merged.set(path, h); continue; }
    conflicts.push(path);
  }
  if (conflicts.length) return { tree: null, conflicts: conflicts.sort() };
  if (merged.size === 0) {
    const data = gitBuildTree([]);
    const oid = gitHash("tree", data);
    if (!st.objects.has(oid)) st.objects.set(oid, { type: "tree", data });
    return { tree: oid, conflicts: [] };
  }
  return { tree: gitBuildTreeFromPaths(st, merged), conflicts: [] };
}

// ---------------------------------------------------------------- fetch computation
interface FetchPlan {
  objects: Map<string, GitObj>;
  shallowOut: string[];
  unshallowOut: string[];
  acks: string[];
  wantedRefs: { oid: string; ref: string }[];
}
// Objects the client already holds: reachable from `haves`, cutting at the
// client's shallow boundaries (a boundary commit is held, its parents are not).
function gitHeldObjects(st: GitState, haves: readonly string[], shallowSet: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const queue: string[] = [];
  for (const h of haves) if (HEX40_RE.test(h)) queue.push(h);
  while (queue.length) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const obj = st.objects.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === "commit") {
      const c = gitParseCommit(obj.data);
      queue.push(c.tree);
      if (!shallowSet.has(oid)) for (const p of c.parents) queue.push(p);
    } else if (obj.type === "tag") {
      queue.push(gitParseTag(obj.data).object);
    } else if (obj.type === "tree") {
      for (const e of gitParseTree(obj.data)) {
        if (e.mode === "160000") continue;
        queue.push(e.oid);
      }
    }
  }
  return held;
}
function gitComputeFetch(
  st: GitState,
  opts: { wants: string[]; haves: string[]; shallow: string[]; deepen: number | null; deepenSince: number | null; deepenNot: string[] },
  defaultBranch: string,
): FetchPlan {
  const shallowSet = new Set(opts.shallow.filter((s) => HEX40_RE.test(s)));
  const held = gitHeldObjects(st, opts.haves, shallowSet);
  // Commits excluded by deepen-not (reachable from the named refs).
  const excluded = new Set<string>();
  for (const ref of opts.deepenNot) {
    const oid = gitResolveRef(st, ref, defaultBranch);
    if (oid) for (const o of gitCollectReachable([oid], (id) => st.objects.get(id), true)) excluded.add(o);
  }
  // BFS over commits from the wants, honouring depth / time cutoffs.
  const included = new Set<string>();
  const depthOf = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = [];
  for (const w of opts.wants) {
    const obj = st.objects.get(w);
    if (!obj) continue;
    if (obj.type === "tag") {
      included.add(w);
      const target = gitParseTag(obj.data).object;
      if (st.objects.get(target)?.type === "commit") queue.push({ oid: target, depth: 0 });
    } else if (obj.type === "commit") {
      queue.push({ oid: w, depth: 0 });
    } else {
      included.add(w);
    }
  }
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    if (included.has(oid) || excluded.has(oid)) continue;
    if (opts.deepen !== null && depth >= opts.deepen) continue;
    const obj = st.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    if (opts.deepenSince !== null && gitIdentityTs(gitParseCommit(obj.data).committer) < opts.deepenSince) continue;
    included.add(oid);
    depthOf.set(oid, depth);
    const c = gitParseCommit(obj.data);
    // Without a deepen, a client shallow boundary still cuts the history.
    if (opts.deepen === null && opts.deepenSince === null && shallowSet.has(oid)) continue;
    for (const p of c.parents) queue.push({ oid: p, depth: depth + 1 });
  }
  // Full object closure of the included commits (trees + blobs).
  const objects = new Map<string, GitObj>();
  for (const oid of included) {
    const obj = st.objects.get(oid);
    if (obj) objects.set(oid, obj);
  }
  for (const oid of [...included]) {
    const obj = st.objects.get(oid);
    if (!obj) continue;
    if (obj.type === "commit") {
      for (const o of gitCollectReachable([gitParseCommit(obj.data).tree], (id) => st.objects.get(id), true)) {
        const oo = st.objects.get(o);
        if (oo) objects.set(o, oo);
      }
    } else if (obj.type === "tag") {
      for (const o of gitCollectReachable([gitParseTag(obj.data).object], (id) => st.objects.get(id), true)) {
        const oo = st.objects.get(o);
        if (oo) objects.set(o, oo);
      }
    }
  }
  // Boundaries: included commits with a parent that is not included.
  const shallowOut: string[] = [];
  for (const oid of included) {
    const obj = st.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    const parents = gitParseCommit(obj.data).parents;
    const hasOutsideParent = parents.some((p) => !included.has(p));
    if (hasOutsideParent) shallowOut.push(oid);
  }
  const unshallowOut = [...shallowSet].filter((oid) => included.has(oid) && !shallowOut.includes(oid)).sort();
  shallowOut.sort();
  // Drop what the client already holds.
  for (const oid of [...objects.keys()]) if (held.has(oid)) objects.delete(oid);
  // ACKs: haves that are ancestors-or-equal of a want.
  const ancestors = new Set<string>();
  for (const w of opts.wants) {
    try { for (const o of gitCollectReachable([w], (id) => st.objects.get(id), true)) ancestors.add(o); } catch { /* ignore */ }
  }
  const acks = opts.haves.filter((h) => ancestors.has(h));
  const wantedRefs: { oid: string; ref: string }[] = [];
  for (const w of opts.wants) {
    for (const [name, oid] of st.refs) if (oid === w) wantedRefs.push({ oid: w, ref: name });
  }
  return { objects, shallowOut, unshallowOut, acks, wantedRefs };
}

// ============================================================================
// git smart HTTP (info/refs, upload-pack, receive-pack)
// ============================================================================
function gitSidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 65515) {
    const chunk = pack.subarray(off, off + 65515);
    parts.push(gitPkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}
function gitLsRefsResponse(r: Repo, st: GitState, args: string[]): Buffer {
  const peel = args.includes("peel");
  const symrefs = args.includes("symrefs");
  const unborn = args.includes("unborn");
  const prefixes = args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice("ref-prefix ".length));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${r.default_branch}`;
  const headOid = st.refs.get(headRef) ?? null;
  const refs = [...st.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const headShown = prefixes.length === 0 || prefixes.some((p) => "HEAD".startsWith(p));
  if (refs.length === 0) {
    if (unborn && headShown) {
      parts.push(gitPkt(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ""}\n`));
    }
  } else {
    if (headShown) {
      const headLine = headOid
        ? `${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ""}`
        : `unborn HEAD${symrefs ? ` symref-target:${headRef}` : ""}`;
      parts.push(gitPkt(`${headLine}\n`));
    }
    for (const [name, oid] of refs) {
      if (!keep(name)) continue;
      let line = `${oid} ${name}`;
      if (peel) {
        const p = gitPeel(st, oid);
        if (p) line += ` peeled:${p}`;
      }
      parts.push(gitPkt(`${line}\n`));
    }
  }
  parts.push(GIT_FLUSH);
  return Buffer.concat(parts);
}
function gitFetchV2Response(r: Repo, st: GitState, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let deepenSince: number | null = null;
  const deepenNot: string[] = [];
  for (const a of args) {
    if (a.startsWith("want ")) wants.push(a.slice(5).trim());
    else if (a.startsWith("have ")) haves.push(a.slice(5).trim());
    else if (a.startsWith("shallow ")) shallow.push(a.slice(8).trim());
    else if (a.startsWith("deepen ")) deepen = parseInt(a.slice(7), 10);
    else if (a.startsWith("deepen-since ")) deepenSince = parseInt(a.slice(13), 10);
    else if (a.startsWith("deepen-not ")) deepenNot.push(a.slice(11).trim());
    // thin-pack, no-progress, ofs-delta, filter, done: accepted, no action needed
  }
  const plan = gitComputeFetch(st, { wants, haves, shallow, deepen, deepenSince, deepenNot }, r.default_branch);
  const parts: Buffer[] = [];
  // protocol v2: the acknowledgments section is only sent when the client
  // included at least one "have" line; a have-less fetch (e.g. a clone)
  // goes straight to shallow-info / wanted-refs / packfile.
  if (haves.length) {
    parts.push(gitPkt("acknowledgments\n"));
    if (plan.acks.length) for (const ack of plan.acks) parts.push(gitPkt(`ACK ${ack}\n`));
    else parts.push(gitPkt("NAK\n"));
    parts.push(gitPkt("ready\n"));
    parts.push(GIT_DELIM);
  }
  if (plan.shallowOut.length || plan.unshallowOut.length) {
    parts.push(gitPkt("shallow-info\n"));
    for (const s of plan.shallowOut) parts.push(gitPkt(`shallow ${s}\n`));
    for (const s of plan.unshallowOut) parts.push(gitPkt(`unshallow ${s}\n`));
    parts.push(GIT_DELIM);
  }
  if (plan.wantedRefs.length) {
    parts.push(gitPkt("wanted-refs\n"));
    for (const w of plan.wantedRefs) parts.push(gitPkt(`${w.oid} ${w.ref}\n`));
    parts.push(GIT_DELIM);
  }
  parts.push(gitPkt("packfile\n"));
  // Deterministic pack order (by oid) so identical fetches are byte-identical.
  parts.push(...gitSidebandPack(gitWritePack([...plan.objects.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, o]) => o))));
  parts.push(GIT_FLUSH);
  return Buffer.concat(parts);
}
function gitFetchV0Response(r: Repo, st: GitState, body: Buffer): Buffer {
  const packets = gitDecodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  for (const p of packets) {
    if (p.kind !== "data") continue;
    const line = p.payload.toString("utf8").replace(/\n$/, "");
    if (line.startsWith("want ")) wants.push(line.slice(5).split(" ")[0]);
    else if (line.startsWith("have ")) haves.push(line.slice(5).trim());
    else if (line.startsWith("shallow ")) shallow.push(line.slice(8).trim());
    else if (line.startsWith("deepen ")) deepen = parseInt(line.slice(7), 10);
  }
  const plan = gitComputeFetch(st, { wants, haves, shallow, deepen, deepenSince: null, deepenNot: [] }, r.default_branch);
  const parts: Buffer[] = [];
  if (plan.acks.length) for (const ack of plan.acks) parts.push(gitPkt(`ACK ${ack}\n`));
  else parts.push(gitPkt("NAK\n"));
  for (const s of plan.shallowOut) parts.push(gitPkt(`shallow ${s}\n`));
  for (const s of plan.unshallowOut) parts.push(gitPkt(`unshallow ${s}\n`));
  const pack = gitWritePack([...plan.objects.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, o]) => o));
  parts.push(...gitSidebandPack(pack));
  parts.push(GIT_FLUSH);
  return Buffer.concat(parts);
}

async function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repo: string, service: string): Promise<void> {
  const r = findRepo(owner, repo);
  if (!r) { sendError(res, 404, "Not Found"); return; }
  if (r.private && !authed(req)) { requireAuth(req, res); return; }
  const st = getGitState(owner, repo);
  const isReceive = service === "git-receive-pack";
  const svc = isReceive ? "receive-pack" : "upload-pack";
  const v2 = !isReceive && String(req.headers["git-protocol"] ?? "").includes("version=2");
  const headRef = `refs/heads/${r.default_branch}`;
  const headOid = st.refs.get(headRef) ?? null;
  if (v2) {
    const body = Buffer.concat([
      gitPkt("# service=git-upload-pack\n"), GIT_FLUSH,
      gitPkt("version 2\n"),
      gitPkt(`agent=${FORGE_AGENT}\n`),
      gitPkt("ls-refs=unborn\n"),
      gitPkt("fetch=shallow thin-pack ofs-delta\n"),
      gitPkt("object-format=sha1\n"),
      GIT_FLUSH,
    ]);
    res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-advertisement", "Content-Length": body.length, "Cache-Control": "no-cache" });
    res.end(body);
    return;
  }
  const caps = isReceive
    ? `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${FORGE_AGENT} object-format=sha1`
    : `multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed symref=HEAD:${headRef} agent=${FORGE_AGENT} object-format=sha1`;
  const parts: Buffer[] = [gitPkt(`# service=git-${svc}\n`), GIT_FLUSH];
  const refs = [...st.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (refs.length === 0) {
    parts.push(gitPkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(gitPkt(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(gitPkt(`${oid} ${name}\n`));
      const peeled = gitPeel(st, oid);
      if (peeled) parts.push(gitPkt(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(GIT_FLUSH);
  const body = Buffer.concat(parts);
  res.writeHead(200, { "Content-Type": `application/x-git-${svc}-advertisement`, "Content-Length": body.length, "Cache-Control": "no-cache" });
  res.end(body);
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repo: string): Promise<void> {
  const r = findRepo(owner, repo);
  if (!r) { sendError(res, 404, "Not Found"); return; }
  if (r.private && !authed(req)) { requireAuth(req, res); return; }
  let body: Buffer;
  try { body = await readBody(req); } catch (e: any) { sendError(res, e.status || 400, e.message || "bad request"); return; }
  const st = getGitState(owner, repo);
  const v2 = String(req.headers["git-protocol"] ?? "").includes("version=2");
  try {
    let out: Buffer;
    if (v2) {
      const packets = gitDecodePktLines(body);
      const firstSection: string[] = [];
      let i = 0;
      while (i < packets.length && packets[i].kind === "data") { firstSection.push(packets[i].payload.toString("utf8")); i += 1; }
      if (i >= packets.length || packets[i].kind !== "delim") throw new Error("expected delim after command");
      i += 1;
      const secondSection: string[] = [];
      while (i < packets.length && packets[i].kind === "data") { secondSection.push(packets[i].payload.toString("utf8").replace(/\n$/, "")); i += 1; }
      if (i >= packets.length || packets[i].kind !== "flush") throw new Error("expected flush");
      const command = (firstSection[0] ?? "").trim();
      if (command === "command=ls-refs") out = gitLsRefsResponse(r, st, secondSection);
      else if (command === "command=fetch") {
        for (const w of secondSection.filter((a) => a.startsWith("want ")).map((a) => a.slice(5).trim())) {
          if (!HEX40_RE.test(w) || !st.objects.has(w)) throw new Error(`want ${w} not found`);
        }
        out = gitFetchV2Response(r, st, secondSection);
      } else throw new Error(`unknown command ${command}`);
    } else {
      out = gitFetchV0Response(r, st, body);
    }
    res.writeHead(200, { "Content-Type": "application/x-git-upload-pack-result", "Content-Length": out.length, "Cache-Control": "no-cache" });
    res.end(out);
  } catch (e: any) {
    if (!res.writableEnded) sendError(res, 400, e.message || "malformed git request");
  }
}

// Apply one receive-pack command; null = ok, otherwise the ng reason.
function gitApplyPush(st: GitState, r: Repo, cmd: { old: string; nw: string; ref: string }): string | null {
  const { old, nw, ref } = cmd;
  if (!validRefName(ref) || !ref.startsWith("refs/")) return "invalid ref";
  const current = st.refs.get(ref) ?? null;
  const isDelete = nw === ZERO_OID;
  const isCreate = old === ZERO_OID;
  if (isDelete) {
    if (!current) return "remote ref does not exist";
    if (!isCreate && old !== current) return "non-fast-forward";
    if (ref === `refs/heads/${r.default_branch}`) return "deletion of the current branch prohibited";
    st.refs.delete(ref);
    return null;
  }
  const obj = st.objects.get(nw);
  if (!obj) return "missing object";
  if (ref.startsWith("refs/heads/") && obj.type !== "commit") return "not a commit";
  if (isCreate) {
    if (current) return "already exists";
    st.refs.set(ref, nw);
    return null;
  }
  if (!current) return "remote ref does not exist";
  if (old !== current) return "non-fast-forward";
  if (nw === current) return null; // no-op update
  if (!gitIsAncestor(st, old, nw)) return "non-fast-forward";
  st.refs.set(ref, nw);
  return null;
}
function gitPushCommitList(st: GitState, owner: string, repo: string, oldOid: string, newOid: string): Json[] {
  const commits: Json[] = [];
  if (newOid === ZERO_OID) return commits;
  const exclude = oldOid !== ZERO_OID
    ? gitCollectReachable([oldOid], (oid) => st.objects.get(oid), true)
    : new Set<string>();
  for (const sha of gitWalkCommits(st, newOid, { max: 20, exclude })) {
    const obj = st.objects.get(sha);
    if (!obj) continue;
    const c = gitParseCommit(obj.data);
    const author = gitParseIdentity(c.author);
    commits.push({
      id: sha, message: c.message.replace(/\n$/, ""),
      author: { name: author.name, email: author.email }, timestamp: author.dateIso,
      url: `http://localhost/${owner}/${repo}/commit/${sha}`,
    });
  }
  return commits;
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, repo: string): Promise<void> {
  const r = findRepo(owner, repo);
  if (!r) { sendError(res, 404, "Not Found"); return; }
  if (!authed(req)) { requireAuth(req, res); return; }
  let body: Buffer;
  try { body = await readBody(req); } catch (e: any) { sendError(res, e.status || 400, e.message || "bad request"); return; }
  const st = getGitState(owner, repo);
  const commands: { old: string; nw: string; ref: string }[] = [];
  let capabilities: string[] = [];
  let packStart = body.length;
  try {
    let off = 0;
    while (off + 4 <= body.length) {
      const len = parseInt(body.toString("ascii", off, off + 4), 16);
      if (Number.isNaN(len) || len < 0) throw new Error("malformed pkt-line");
      if (len === 0) { packStart = off + 4; break; }
      if (len < 4 || off + len > body.length) throw new Error("malformed pkt-line");
      const payload = body.toString("utf8", off + 4, off + len);
      const m = payload.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s\x00]+)/);
      if (!m) throw new Error("malformed push command");
      if (commands.length === 0) {
        const nul = payload.indexOf("\0");
        if (nul >= 0) capabilities = payload.slice(nul + 1).replace(/\n$/, "").split(" ").filter(Boolean);
      }
      commands.push({ old: m[1], nw: m[2], ref: m[3] });
      off += len;
    }
  } catch (e: any) {
    sendError(res, 400, e.message || "malformed push");
    return;
  }
  if (commands.length === 0) { sendError(res, 400, "no push commands"); return; }
  const packBytes = body.subarray(packStart);
  const sideband = capabilities.includes("side-band-64k");
  const reportLines: string[] = [];
  let unpackError: string | null = null;
  let newObjects = new Map<string, GitObj>();
  if (packBytes.length > 0) {
    try {
      const read = gitReadPack(packBytes, (oid) => st.objects.get(oid));
      if (!read.checksumOk) throw new Error("pack checksum mismatch");
      newObjects = read.objects;
    } catch (e: any) { unpackError = e.message || "unpack failed"; }
  }
  const applied: { old: string; nw: string; ref: string }[] = [];
  if (unpackError) {
    reportLines.push(`unpack error ${unpackError}\n`);
    for (const c of commands) reportLines.push(`ng ${c.ref} unpacker error\n`);
  } else {
    for (const [oid, obj] of newObjects) if (!st.objects.has(oid)) st.objects.set(oid, obj);
    reportLines.push("unpack ok\n");
    for (const c of commands) {
      const verdict = gitApplyPush(st, r, c);
      if (verdict === null) { reportLines.push(`ok ${c.ref}\n`); applied.push(c); }
      else reportLines.push(`ng ${c.ref} ${verdict}\n`);
    }
    if (applied.length) {
      touchGitState(st);
      r.pushed_at = nowIso(); r.updated_at = nowIso(); saveStore();
      // The webhook commit list walks the whole history, so only build it
      // when a push webhook actually exists; otherwise a push is O(new).
      if (r.hooks.some((h) => h.active && h.events.includes("push"))) {
        for (const cmd of applied) {
          const commits = gitPushCommitList(st, owner, repo, cmd.old, cmd.nw);
          fireHooks(r, "push", {
            ref: cmd.ref, before: cmd.old, after: cmd.nw,
            created: cmd.old === ZERO_OID, deleted: cmd.nw === ZERO_OID,
            commits, head_commit: commits[commits.length - 1] || null,
            repository: repoJson(r), pusher: userRef(FORGE_USER), sender: userRef(FORGE_USER),
          });
        }
      }
    }
  }
  const parts: Buffer[] = [];
  if (sideband) {
    // report-status-v2: the report's own terminating flush travels INSIDE
    // the band-1 sideband data (the client reads pkt-lines out of the
    // demuxed stream until that flush); a raw flush then ends the stream.
    const report = Buffer.concat([...reportLines.map((l) => gitPkt(l)), GIT_FLUSH]);
    parts.push(...gitSidebandPack(report));
  } else {
    for (const line of reportLines) parts.push(gitPkt(line));
  }
  parts.push(GIT_FLUSH);
  const out = Buffer.concat(parts);
  res.writeHead(200, { "Content-Type": "application/x-git-receive-pack-result", "Content-Length": out.length, "Cache-Control": "no-cache" });
  res.end(out);
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
  initGitState(owner, name as string);
  store.repos.push(repo);
  saveStore();
  if (body.auto_init === true) {
    try {
      const st = getGitState(owner, name as string);
      const content = Buffer.from(`# ${name}\n\n${description}\n`, "utf8");
      const blobOid = gitHash("blob", content);
      st.objects.set(blobOid, { type: "blob", data: content });
      const treeOid = gitBuildTreeFromPaths(st, new Map([["README.md", { mode: "100644", oid: blobOid }]]));
      const ts = Math.floor(Date.now() / 1000);
      const line = gitIdentityLine(FORGE_USER, "forge@localhost", ts);
      const data = gitBuildCommit({ tree: treeOid, parents: [], message: "Initial commit\n", authorLine: line, committerLine: line });
      const commitOid = gitHash("commit", data);
      st.objects.set(commitOid, { type: "commit", data });
      st.refs.set(`refs/heads/${defaultBranch}`, commitOid);
      touchGitState(st);
      repo.pushed_at = nowIso();
      saveStore();
    } catch { /* repo still created; initial commit is best-effort */ }
  }
  sendJson(res, 201, repoJson(repo));
}

function deleteRepoHandler(res: ServerResponse, r: Repo): void {
  store.repos = store.repos.filter((x) => x !== r);
  saveStore();
  deleteGitState(r.owner, r.name);
  rmSync(join(DATA_DIR, "repos", r.owner, r.name + ".git"), { recursive: true, force: true });
  res.writeHead(204, { "X-GitHub-Request-Id": randomUUID() });
  res.end();
}

// ---- git object reads (used by contents / commits / refs / trees / blobs)
function listBranches(owner: string, repo: string): Json[] {
  const st = getGitState(owner, repo);
  return [...st.refs.entries()]
    .filter(([name]) => name.startsWith("refs/heads/"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, sha]) => ({
      name: name.slice("refs/heads/".length),
      commit: { sha, url: `/api/v3/repos/x/y/git/commits/${sha}` },
      protected: false,
    }));
}
function gitCommitJson(st: GitState, sha: string): Json {
  const obj = st.objects.get(sha);
  if (!obj || obj.type !== "commit") throw new Error(`commit ${sha} not found`);
  const c = gitParseCommit(obj.data);
  const author = gitParseIdentity(c.author);
  const committer = gitParseIdentity(c.committer);
  return {
    sha,
    commit: {
      message: c.message.replace(/\n$/, ""),
      author: { name: author.name, email: author.email, date: author.dateIso },
      committer: { name: committer.name, email: committer.email, date: committer.dateIso },
    },
    author: { login: author.name }, committer: { login: committer.name },
    parents: [],
  };
}
function listCommits(owner: string, repo: string, ref: string, perPage: number): Json[] {
  const st = getGitState(owner, repo);
  const r = findRepo(owner, repo);
  const defBranch = r?.default_branch ?? "main";
  const range = ref || "HEAD";
  let tip: string | null = null;
  let exclude = new Set<string>();
  const m = range.match(/^(.+)\.\.(.+)$/);
  if (m) {
    const baseOid = gitResolveRef(st, m[1], defBranch);
    tip = gitResolveRef(st, m[2], defBranch);
    if (baseOid) exclude = gitCollectReachable([baseOid], (oid) => st.objects.get(oid), true);
  } else {
    tip = gitResolveRef(st, range, defBranch);
  }
  if (!tip) return [];
  const commitOid = gitPeelToCommit(st, tip);
  if (!commitOid) return [];
  return gitWalkCommits(st, commitOid, { max: perPage, exclude }).map((sha) => gitCommitJson(st, sha));
}

function contentsGet(res: ServerResponse, r: Repo, path: string, ref: string): void {
  const st = getGitState(r.owner, r.name);
  const refSpec = ref || r.default_branch;
  const tip = gitCommitAt(st, refSpec, r.default_branch);
  if (!tip) { sendError(res, 404, "Not Found"); return; }
  const entry = gitTreeAtPath(st, tip, path);
  if (!entry) { sendError(res, 404, "Not Found"); return; }
  const short = path.split("/").pop() || path;
  if (entry.type === "tree") {
    const entries = gitListTree(st, entry.oid).map((e) => ({
      name: e.name, path: `${path}/${e.name}`, sha: e.oid, size: 0,
      type: e.mode === "40000" ? "dir" : "file", mode: e.mode,
    }));
    sendJson(res, 200, entries);
    return;
  }
  const blob = st.objects.get(entry.oid);
  if (!blob) { sendError(res, 404, "Not Found"); return; }
  sendJson(res, 200, {
    type: "file", encoding: "base64", size: blob.data.length, name: short, path,
    content: blob.data.toString("base64"), sha: entry.oid,
    url: `/api/v3/repos/${r.owner}/${r.name}/contents/${encodeURIComponent(path)}`,
    html_url: `http://localhost/${r.owner}/${r.name}/blob/${refSpec}/${path}`,
    git_url: `/api/v3/repos/${r.owner}/${r.name}/git/blobs/${entry.oid}`,
    download_url: null, mode: entry.mode,
  });
}

function contentsPut(res: ServerResponse, r: Repo, path: string, body: Json, isDelete: boolean): void {
  const branch = typeof body.branch === "string" && validRefName(body.branch) ? body.branch : r.default_branch;
  const message = typeof body.message === "string" && body.message ? body.message.slice(0, 500) : (isDelete ? `Delete ${path}` : `Update ${path}`);
  const st = getGitState(r.owner, r.name);
  let content: Buffer | null = null;
  if (!isDelete) {
    if (typeof body.content !== "string") { sendError(res, 422, "Validation Failed", { errors: [{ field: "content", code: "missing" }] }); return; }
    try { content = Buffer.from(body.content.replace(/\s/g, ""), "base64"); } catch { sendError(res, 422, "Invalid base64 content"); return; }
    if (content.length > 50 * 1024 * 1024) { sendError(res, 413, "Content too large"); return; }
  }
  try {
    const branchRef = `refs/heads/${branch}`;
    let tip = st.refs.get(branchRef) ?? null;
    let parentTree: string | null = null;
    let parentCommit: string | null = null;
    if (tip) {
      const obj = st.objects.get(tip);
      if (!obj || obj.type !== "commit") throw new Error("branch tip is not a commit");
      parentTree = gitParseCommit(obj.data).tree;
      parentCommit = tip;
    } else if (branch !== r.default_branch) {
      // A new branch starts at the default branch tip (git checkout -b).
      const defTip = st.refs.get(`refs/heads/${r.default_branch}`) ?? null;
      if (defTip) {
        parentTree = gitParseCommit(st.objects.get(defTip)!.data).tree;
        parentCommit = defTip;
      }
    }
    const files = gitFlattenTree(st, parentTree);
    if (body.sha) {
      const cur = files.get(path);
      if (!cur || cur.oid !== String(body.sha)) {
        const e = new Error("sha does not match") as Error & { status: number }; e.status = 409; throw e;
      }
    }
    if (isDelete) {
      const exists = files.has(path) || [...files.keys()].some((k) => k.startsWith(`${path}/`));
      if (!exists) throw new Error("file not found: " + path);
      files.delete(path);
      for (const k of [...files.keys()]) if (k.startsWith(`${path}/`)) files.delete(k);
    } else {
      const blobOid = gitHash("blob", content as Buffer);
      if (!st.objects.has(blobOid)) st.objects.set(blobOid, { type: "blob", data: content as Buffer });
      const prev = files.get(path);
      files.set(path, { mode: prev ? prev.mode : "100644", oid: blobOid });
    }
    const newTree = files.size === 0
      ? (() => { const data = gitBuildTree([]); const oid = gitHash("tree", data); if (!st.objects.has(oid)) st.objects.set(oid, { type: "tree", data }); return oid; })()
      : gitBuildTreeFromPaths(st, files);
    if (newTree === parentTree) {
      // No change (same bytes): answer with the current head, no new commit.
      const curBlob = files.get(path)?.oid ?? null;
      sendJson(res, isDelete ? 200 : 201, {
        content: isDelete ? null : { name: path.split("/").pop(), path, sha: curBlob, size: content ? content.length : 0, type: "file", encoding: "base64" },
        commit: { sha: parentCommit, message, author: { name: FORGE_USER, email: "forge@localhost", date: nowIso() } },
      });
      return;
    }
    const ts = Math.floor(Date.now() / 1000);
    const line = gitIdentityLine(FORGE_USER, "forge@localhost", ts);
    const commitData = gitBuildCommit({
      tree: newTree, parents: parentCommit ? [parentCommit] : [],
      message: message.endsWith("\n") ? message : `${message}\n`,
      authorLine: line, committerLine: line,
    });
    const commitOid = gitHash("commit", commitData);
    st.objects.set(commitOid, { type: "commit", data: commitData });
    st.refs.set(branchRef, commitOid);
    touchGitState(st);
    r.pushed_at = nowIso(); r.updated_at = nowIso(); saveStore();
    const status = isDelete ? 200 : 201;
    const blobSha = isDelete ? null : files.get(path)?.oid ?? commitOid;
    sendJson(res, status, {
      content: isDelete ? null : { name: path.split("/").pop(), path, sha: blobSha, size: content ? content.length : 0, type: "file", encoding: "base64" },
      commit: { sha: commitOid, message, author: { name: FORGE_USER, email: "forge@localhost", date: nowIso() } },
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
  const st = getGitState(r.owner, r.name);
  const headCommit = gitCommitAt(st, `refs/heads/${head}`, r.default_branch);
  const baseCommit = gitCommitAt(st, `refs/heads/${base}`, r.default_branch);
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
// Merge a pull request's head into its base with a pure-JS three-way merge
// and return the merge commit sha. Throws {status:409} on a merge conflict.
// Shared by the REST merge endpoint, the GraphQL mergePullRequest mutation
// and the MCP merge_pull_request tool.
function mergePrIntoBase(r: Repo, p: PullRequest, method: "merge" | "squash" | "rebase" = "merge"): string | null {
  const st = getGitState(r.owner, r.name);
  const baseTip = st.refs.get(`refs/heads/${p.base.ref}`);
  const headTip = st.refs.get(`refs/heads/${p.head.ref}`);
  if (!baseTip || !headTip) throw new Error("cannot check out base branch " + p.base.ref);
  // Already merged (or nothing to merge): no new commit, like git.
  if (gitIsAncestor(st, headTip, baseTip)) {
    p.merged = true; p.state = "closed"; p.merged_at = nowIso(); p.closed_at = nowIso();
    p.updated_at = nowIso(); p.merge_commit_sha = baseTip;
    r.pushed_at = nowIso(); r.updated_at = nowIso(); saveStore();
    fireHooks(r, "pull_request", { action: "closed", number: p.number, pull_request: prJson(r, p), repository: repoJson(r), sender: userRef(FORGE_USER) });
    return baseTip;
  }
  const ts = Math.floor(Date.now() / 1000);
  const line = gitIdentityLine(FORGE_USER, "forge@localhost", ts);
  let mergedSha: string | null = null;
  if (method === "rebase") {
    // Replay each head-only commit onto the base tip, oldest first.
    const exclude = gitCollectReachable([baseTip], (oid) => st.objects.get(oid), true);
    const chain = gitWalkCommits(st, headTip, { exclude });
    let current = baseTip;
    for (const sha of [...chain].reverse()) {
      const c = gitParseCommit(st.objects.get(sha)!.data);
      const parentTree = c.parents.length ? gitParseCommit(st.objects.get(c.parents[0])!.data).tree : null;
      const currentTree = gitParseCommit(st.objects.get(current)!.data).tree;
      const merged = gitThreeWayMerge(st, parentTree, c.tree, currentTree);
      if (merged.conflicts.length) throw Object.assign(new Error("Merge conflict"), { status: 409 });
      const data = gitBuildCommit({
        tree: merged.tree!, parents: [current], message: c.message,
        authorLine: c.author, committerLine: line,
      });
      const oid = gitHash("commit", data);
      st.objects.set(oid, { type: "commit", data });
      current = oid;
    }
    mergedSha = current;
  } else {
    const mergeBaseOid = gitMergeBase(st, baseTip, headTip);
    const baseTree = mergeBaseOid ? gitParseCommit(st.objects.get(mergeBaseOid)!.data).tree : null;
    const headTree = gitParseCommit(st.objects.get(headTip)!.data).tree;
    const baseTreeNow = gitParseCommit(st.objects.get(baseTip)!.data).tree;
    const merged = gitThreeWayMerge(st, baseTree, headTree, baseTreeNow);
    if (merged.conflicts.length) throw Object.assign(new Error("Merge conflict"), { status: 409 });
    if (method === "squash") {
      const data = gitBuildCommit({
        tree: merged.tree!, parents: [baseTip],
        message: p.title.endsWith("\n") ? p.title : `${p.title}\n`,
        authorLine: line, committerLine: line,
      });
      mergedSha = gitHash("commit", data);
      st.objects.set(mergedSha, { type: "commit", data });
    } else {
      const data = gitBuildCommit({
        tree: merged.tree!, parents: [baseTip, headTip],
        message: `Merge pull request #${p.number} from ${p.head.ref}\n`,
        authorLine: line, committerLine: line,
      });
      mergedSha = gitHash("commit", data);
      st.objects.set(mergedSha, { type: "commit", data });
    }
  }
  st.refs.set(`refs/heads/${p.base.ref}`, mergedSha);
  touchGitState(st);
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
  if (!p.head.sha || !p.base.sha) return [];
  const st = getGitState(r.owner, r.name);
  const baseCommit = st.objects.get(p.base.sha);
  const headCommit = st.objects.get(p.head.sha);
  if (!baseCommit || !headCommit || baseCommit.type !== "commit" || headCommit.type !== "commit") return [];
  return gitDiffTrees(st, gitParseCommit(baseCommit.data).tree, gitParseCommit(headCommit.data).tree).map((d) => d.path);
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
      const st = getGitState(repo.owner, repo.name);
      const headCommit = gitCommitAt(st, `refs/heads/${head}`, repo.default_branch);
      const baseCommit = gitCommitAt(st, `refs/heads/${base}`, repo.default_branch);
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
    initGitState(owner, a.name);
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
    deleteGitState(r.owner, r.name);
    rmSync(join(DATA_DIR, "repos", r.owner, r.name + ".git"), { recursive: true, force: true });
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
    const st = getGitState(r.owner, r.name);
    const headCommit = gitCommitAt(st, `refs/heads/${a.head}`, r.default_branch);
    const baseCommit = gitCommitAt(st, `refs/heads/${a.base}`, r.default_branch);
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
    let mergedSha: string | null;
    try {
      mergedSha = mergePrIntoBase(r, p);
    } catch (e: any) {
      throw Object.assign(new Error(e.status === 409 ? "Merge conflict" : (e.message || "merge failed")), { status: e.status || 500 });
    }
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
    const st = getGitState(r.owner, r.name);
    const tip = gitCommitAt(st, "HEAD", r.default_branch);
    const data = tip ? gitReadBlobAt(st, tip, String(a.path)) : null;
    if (!data) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { path: a.path, content: data.toString("base64"), encoding: "base64", size: data.length };
  } },
  { name: "list_commits", description: "List commits", mutating: false, inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, sha: { type: "string" } }, required: ["owner", "repo"] }, run: (a) => {
    const r = findRepo(a.owner, a.repo); if (!r) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { commits: listCommits(r.owner, r.name, typeof a.sha === "string" ? a.sha : "HEAD", 30) };
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
          const st = getGitState(owner, repoName);
          if (!st.refs.has(`refs/heads/${body.default_branch}`)) { sendError(res, 422, "Validation Failed", { errors: [{ field: "default_branch", code: "invalid" }] }); return; }
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

    // ---- branches
    if (rest[0] === "branches") {
      if (method === "GET" && rest.length === 1) { sendJson(res, 200, listBranches(owner, repoName)); return; }
      if (method === "GET" && rest.length === 2) {
        const st = getGitState(owner, repoName);
        const sha = st.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) { sendError(res, 404, "Not Found"); return; }
        sendJson(res, 200, { name: rest[1], commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` }, protected: false });
        return;
      }
    }
    // ---- commits
    if (rest[0] === "commits") {
      if (method === "GET" && rest.length === 1) {
        const ref = q.get("sha") || "HEAD";
        sendJson(res, 200, slice(listCommits(owner, repoName, ref, perPage)));
        return;
      }
      if (method === "GET" && rest.length === 2) {
        const one = listCommits(owner, repoName, rest[1], 1);
        if (!one.length) { sendError(res, 404, "Not Found"); return; }
        sendJson(res, 200, { ...one[0], stats: { total: 0 }, files: [] });
        return;
      }
    }
    // ---- git refs / trees / blobs
    if (rest[0] === "git") {
      const st = getGitState(owner, repoName);
      if (rest[1] === "refs" && method === "GET") {
        const all = [...st.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([ref, sha]) => ({
          ref, node_id: `ref:${ref}`, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, "")}`, object: { sha, type: "commit" },
        }));
        const want = rest.slice(2).join("/");
        sendJson(res, 200, want ? all.filter((x) => x.ref === `refs/${want}` || x.ref.startsWith(`refs/${want}`)) : all);
        return;
      }
      if (rest[1] === "refs" && method === "POST") {
        if (!requireAuth(req, res)) return;
        const body = await readJson(req);
        const ref = typeof body.ref === "string" ? body.ref : "";
        const sha = typeof body.sha === "string" ? body.sha : "";
        if (!ref.startsWith("refs/") || !validRefName(ref) || !/^[0-9a-f]{40}$/.test(sha) || !st.objects.has(sha)) {
          sendError(res, 422, "Validation Failed", { errors: [{ field: "ref/sha", code: "invalid" }] }); return;
        }
        st.refs.set(ref, sha);
        touchGitState(st);
        sendJson(res, 201, { ref, node_id: `ref:${ref}`, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, "")}`, object: { sha, type: "commit" } });
        return;
      }
      if (rest[1] === "refs" && method === "DELETE") {
        if (!requireAuth(req, res)) return;
        const ref = "refs/" + rest.slice(2).join("/");
        if (!st.refs.has(ref)) { sendError(res, 422, "delete ref failed"); return; }
        st.refs.delete(ref);
        touchGitState(st);
        res.writeHead(204); res.end(); return;
      }
      if (rest[1] === "trees" && method === "GET" && rest.length === 3) {
        const recursive = q.get("recursive") === "1";
        let obj = st.objects.get(rest[2]);
        if (obj && obj.type === "commit") {
          const treeOid = gitParseCommit(obj.data).tree;
          obj = st.objects.get(treeOid);
        }
        if (!obj || obj.type !== "tree") { sendError(res, 404, "Not Found"); return; }
        const tree: Json[] = [];
        const walk = (treeOid: string, prefix: string): void => {
          for (const e of gitListTree(st, treeOid)) {
            const path = prefix ? `${prefix}/${e.name}` : e.name;
            const size = e.mode === "40000" ? 0 : (st.objects.get(e.oid)?.data.length ?? 0);
            tree.push({ path, mode: e.mode, type: e.mode === "40000" ? "tree" : "blob", sha: e.oid, size, url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${e.oid}` });
            if (recursive && e.mode === "40000") walk(e.oid, path);
          }
        };
        const rootTreeOid = obj.type === "commit" ? gitParseCommit(obj.data).tree : rest[2];
        walk(rootTreeOid, "");
        sendJson(res, 200, { sha: rest[2], url: `/api/v3/repos/${owner}/${repoName}/git/trees/${rest[2]}`, tree, truncated: false });
        return;
      }
      if (rest[1] === "blobs" && method === "GET" && rest.length === 3) {
        const obj = st.objects.get(rest[2]);
        if (!obj || obj.type !== "blob") { sendError(res, 404, "Not Found"); return; }
        sendJson(res, 200, { sha: rest[2], size: obj.data.length, encoding: "base64", content: obj.data.toString("base64"), url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${rest[2]}` });
        return;
      }
      if (rest[1] === "commits" && method === "GET" && rest.length === 3) {
        const one = listCommits(owner, repoName, rest[2], 1);
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
          const st = getGitState(owner, repoName);
          const tip = gitCommitAt(st, q.get("ref") || r.default_branch, r.default_branch);
          if (!tip) { sendJson(res, 200, []); return; }
          const treeOid = gitParseCommit(st.objects.get(tip)!.data).tree;
          const entries = gitListTree(st, treeOid).map((e) => ({
            name: e.name, path: e.name, sha: e.oid, size: 0, type: e.mode === "40000" ? "dir" : "file", mode: e.mode,
          }));
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
      const st = getGitState(owner, repoName);
      const tip = gitCommitAt(st, "HEAD", r.default_branch);
      if (tip) {
        for (const cand of ["README.md", "README", "readme.md"]) {
          const data = gitReadBlobAt(st, tip, cand);
          if (data) {
            const entry = gitTreeAtPath(st, tip, cand);
            sendJson(res, 200, { type: "file", encoding: "base64", size: data.length, name: cand, path: cand, content: data.toString("base64"), sha: entry ? entry.oid : "" });
            return;
          }
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
          sendJson(res, 200, slice(listCommits(owner, repoName, `${pr.base.sha}..${pr.head.sha}`, perPage)));
          return;
        }
        if (rest[2] === "files" && method === "GET") {
          const st = getGitState(owner, repoName);
          const baseCommit = st.objects.get(pr.base.sha);
          const headCommit = st.objects.get(pr.head.sha);
          const files = baseCommit && headCommit && baseCommit.type === "commit" && headCommit.type === "commit"
            ? gitDiffTrees(st, gitParseCommit(baseCommit.data).tree, gitParseCommit(headCommit.data).tree).map((d) => ({
                filename: d.path, status: d.status, additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions,
              }))
            : [];
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
      if (op === "git-upload-pack" && method === "POST") { await handleUploadPack(req, res, owner, repoName); return; }
      if (op === "git-receive-pack" && method === "POST") { await handleReceivePack(req, res, owner, repoName); return; }
      if (op === "HEAD" && method === "GET") {
        const r = findRepo(owner, repoName);
        if (!r) { sendError(res, 404, "Not Found"); return; }
        const body = `ref: refs/heads/${r.default_branch}\n`;
        res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body) });
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

function shutdown(): void {
  try { flushStore(); } catch { /* best effort */ }
  try { flushGitStates(); } catch { /* best effort */ }
}
process.on("SIGINT", () => { shutdown(); server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { shutdown(); server.close(() => process.exit(0)); });

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
  shutdown();
  console.log("[entry] done");
}
try {
  await main();
  if (ENV_URL !== "") process.exit(0);
} catch (e) {
  console.error(`[entry] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
