// git.ts — smart-HTTP git surface (protocol v2 + v0 upload-pack, v0 receive-pack).
// Routes live under /{owner}/{repo}.git; owner must be VIEWER.login and the repo must
// exist, else 404 {"message":"Not Found"}. Missing/wrong Bearer token → 401.
// Returns null for any path that is not a /{owner}/{repo}.git/... route.

import {
  ZERO_OID,
  collectReachable,
  parseCommit,
  parseTag,
  parseTree,
  pktDecode,
  pktFlush,
  pktLine,
  readPack,
  writePack,
} from './gitobj.ts';
import type { GitObject, Pkt } from './gitobj.ts';
import { VIEWER, isAuthed } from './store.ts';
import type { Ctx, Repo, Req, Resp, Store } from './store.ts';

const AGENT = 'makefun-git/1.0';
const HEX40 = /^[0-9a-f]{40}$/;

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

function json(status: number, body: object): Resp {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: `${JSON.stringify(body)}\n`,
  };
}

function notFound(): Resp {
  return json(404, { message: 'Not Found' });
}

function header(req: Req, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === want) return value;
  }
  return undefined;
}

export async function handleGit(store: Store, ctx: Ctx, req: Req): Promise<Resp | null> {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(req.path);
  if (!match) return null;
  const owner = match[1];
  const repoName = match[2];
  const rest = match[3];
  if (rest === undefined) return null; // bare /{owner}/{repo}.git is not a git route
  if (!isAuthed(ctx)) return json(401, { message: 'Unauthorized' });
  if (owner !== VIEWER.login) return notFound();
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound();
  try {
    if (req.method === 'GET' && rest === '/info/refs') {
      const service = req.query.get('service');
      if (service === 'git-upload-pack') return advertiseUploadPack(repo, req);
      if (service === 'git-receive-pack') return advertiseReceivePack(repo);
      return notFound();
    }
    if (req.method === 'POST' && rest === '/git-upload-pack') return uploadPack(store, repo, req);
    if (req.method === 'POST' && rest === '/git-receive-pack') return receivePack(store, repo, req);
    return notFound();
  } catch (err) {
    // A malformed request (or any surprise) must be an HTTP error, never a crash/hang.
    return json(400, { message: err instanceof Error ? err.message : 'Bad Request' });
  }
}

// ---------------------------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** If the ref points at an annotated tag object, the commit it peels to; else undefined. */
function peeledOid(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  const seen = new Set<string>();
  let current = parseTag(obj.data).object;
  while (!seen.has(current)) {
    seen.add(current);
    const target = repo.objects.get(current);
    if (!target) return undefined;
    if (target.type === 'commit') return current;
    if (target.type === 'tag') {
      current = parseTag(target.data).object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// advertisements (GET info/refs)
// ---------------------------------------------------------------------------------------------

function v0Advertisement(
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  caps: string,
): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = repo.headSha() ?? ZERO_OID;
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertiseUploadPack(repo: Repo, req: Req): Resp {
  if (header(req, 'git-protocol') === 'version=2') {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow filter\n'),
      pktLine('object-format=sha1\n'),
      pktFlush(),
    ]);
    return { status: 200, headers: { 'content-type': UPLOAD_AD_CT }, body };
  }
  const caps =
    'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack_detailed shallow ' +
    `agent=${AGENT}`;
  return {
    status: 200,
    headers: { 'content-type': UPLOAD_AD_CT },
    body: v0Advertisement(repo, 'git-upload-pack', caps),
  };
}

function advertiseReceivePack(repo: Repo): Resp {
  // Receive-pack is v0-only, whatever the client asked for.
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  return {
    status: 200,
    headers: { 'content-type': RECEIVE_AD_CT },
    body: v0Advertisement(repo, 'git-receive-pack', caps),
  };
}

// ---------------------------------------------------------------------------------------------
// POST git-upload-pack: ls-refs (v2), fetch (v2), fetch (v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenNot: string[];
}

/** Pull want/have/shallow/deepen lines out of a decoded upload-pack request. */
function parseFetchArgs(packets: readonly Pkt[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8');
    if (line.startsWith('command=')) continue;
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0].replace(/\n$/, '');
      if (HEX40.test(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).replace(/\n$/, '');
      if (HEX40.test(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).replace(/\n$/, '');
      if (HEX40.test(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(depth) && depth > 0) args.depth = depth;
    } else if (line.startsWith('deepen-not ')) {
      args.deepenNot.push(line.slice(11).replace(/\n$/, ''));
    }
    // done / thin-pack / no-progress / ofs-delta / filter / agent / object-format: ignored.
  }
  return args;
}

/** Add a tree's full closure (trees + blobs) to `out`, tolerating missing objects. */
function addTreeClosure(repo: Repo, treeOid: string, out: Set<string>): void {
  const stack: string[] = [treeOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
}

/**
 * Objects reachable from `wants`, limited to `depth` commit generations when given
 * (depth 1 = the wanted commits + their trees/blobs only). Returns the included set and
 * the boundary commits (included commits whose parents were cut off by the depth limit).
 */
function collectDepthLimited(
  repo: Repo,
  wants: readonly string[],
  depth: number | null,
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const queue: { oid: string; d: number }[] = [];
  const seenCommit = new Set<string>();
  for (const want of wants) {
    if (!HEX40.test(want)) continue;
    let current = want;
    // Peel tag wants to their commit, keeping the tag objects themselves.
    for (;;) {
      const obj = repo.objects.get(current);
      if (!obj) break;
      if (obj.type === 'tag') {
        included.add(current);
        current = parseTag(obj.data).object;
        continue;
      }
      break;
    }
    const target = repo.objects.get(current);
    if (!target) continue;
    if (target.type === 'commit') queue.push({ oid: current, d: 1 });
    else included.add(current);
  }
  while (queue.length) {
    const { oid, d } = queue.shift()!;
    if (seenCommit.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seenCommit.add(oid);
    included.add(oid);
    const commit = parseCommit(obj.data);
    addTreeClosure(repo, commit.tree, included);
    if (depth !== null && d >= depth) {
      boundary.add(oid);
      continue;
    }
    for (const parent of commit.parents) queue.push({ oid: parent, d: d + 1 });
  }
  return { included, boundary };
}

/**
 * What the client already holds: the full closure of its haves, except that traversal
 * stops at its shallow boundaries (a shallow commit's tree/blobs are held, its parents
 * are not). Missing haves are skipped.
 */
function collectHeld(repo: Repo, haves: readonly string[], shallowSet: Set<string>): Set<string> {
  const held = new Set<string>();
  const queue: string[] = [];
  const seen = new Set<string>();
  for (const have of haves) {
    if (!HEX40.test(have)) continue;
    let current = have;
    for (;;) {
      const obj = repo.objects.get(current);
      if (!obj) break;
      if (obj.type === 'tag') {
        held.add(current);
        current = parseTag(obj.data).object;
        continue;
      }
      break;
    }
    const target = repo.objects.get(current);
    if (!target) continue;
    if (target.type === 'commit') queue.push(current);
    else held.add(current);
  }
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    held.add(oid);
    addTreeClosure(repo, parseCommit(obj.data).tree, held);
    if (shallowSet.has(oid)) continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return held;
}

interface FetchPlan {
  objects: GitObject[];
  acks: string[];
  shallow: string[];
  unshallow: string[];
  shallowSection: boolean;
}

function computeFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // wantFull is only used for ACKs; with no haves there is nothing to acknowledge, so skip
  // the full reachability walk — it walks the whole history, and the clone workload's hot path
  // (50 concurrent depth-1 clones, no haves) paid it on every fetch.
  let wantFull: Set<string> = new Set<string>();
  if (args.haves.length > 0) {
    try {
      wantFull = collectReachable(args.wants, lookup);
    } catch {
      wantFull = new Set<string>();
    }
  }
  const { included, boundary } = collectDepthLimited(repo, args.wants, args.depth ?? null);
  const held = collectHeld(repo, args.haves, new Set(args.shallow));
  for (const ref of args.deepenNot) {
    const oid = repo.refs.get(ref) ?? (ref === 'HEAD' ? repo.headSha() : undefined);
    if (!oid) continue;
    try {
      for (const excluded of collectReachable([oid], lookup)) included.delete(excluded);
    } catch {
      // deepen-not target missing: nothing to exclude.
    }
  }
  const deliverable = [...included].filter((oid) => !held.has(oid)).sort();
  const objects: GitObject[] = [];
  for (const oid of deliverable) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  const acks = args.haves.filter((have) => wantFull.has(have));
  const unshallow = args.shallow.filter((old) => included.has(old) && !boundary.has(old));
  return {
    objects,
    acks,
    shallow: [...boundary].sort(),
    unshallow,
    shallowSection: args.depth !== undefined || args.shallow.length > 0,
  };
}

/** Split a pack into band-1 sideband packets (payload ≤ 32769 bytes each). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 32768) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 32768));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function lsRefs(repo: Repo, packets: readonly Pkt[]): Resp {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !seenDelim) continue;
    const line = packet.data.toString('utf8');
    if (line === 'peel\n') peel = true;
    else if (line === 'symrefs\n') symrefs = true;
    else if (line === 'unborn\n') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).replace(/\n$/, ''));
  }
  const lines: string[] = [];
  const headOid = repo.headSha();
  const includeHead = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (includeHead) {
    const symrefAttr = symrefs ? ' symref-target:refs/heads/main' : '';
    if (headOid === undefined && unborn) lines.push(`unborn HEAD${symrefAttr}\n`);
    else lines.push(`${headOid ?? ZERO_OID} HEAD${symrefAttr}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (prefixes.length && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const body = Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT_CT }, body };
}

function fetchV2(repo: Repo, packets: readonly Pkt[]): Resp {
  const args = parseFetchArgs(packets);
  const key = fetchCacheKey(repo, args, 'v2');
  const cached = FETCH_CACHE.get(key);
  if (cached !== undefined) {
    return { status: 200, headers: { 'content-type': UPLOAD_RESULT_CT }, body: cached };
  }
  const plan = computeFetch(repo, args);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktFlush());
  if (plan.shallowSection) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(writePack(plan.objects)));
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  fetchCachePut(key, body);
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT_CT }, body };
}

function fetchV0(repo: Repo, packets: readonly Pkt[]): Resp {
  const args = parseFetchArgs(packets);
  const key = fetchCacheKey(repo, args, 'v0');
  const cached = FETCH_CACHE.get(key);
  if (cached !== undefined) {
    return { status: 200, headers: { 'content-type': UPLOAD_RESULT_CT }, body: cached };
  }
  const plan = computeFetch(repo, args);
  const parts: Buffer[] = [];
  if (plan.acks.length) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(writePack(plan.objects)));
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  fetchCachePut(key, body);
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT_CT }, body };
}

/**
 * Identical-fetch response cache. Git objects are immutable, and the key pins the wanted tip
 * oids plus the resolved deepen-not targets, so an identical key always yields identical bytes
 * (a ref move changes the tip oid in `wants`, or the resolved deepen-not oid, and misses).
 * Bounded FIFO via Map insertion order; one entry per process (one trial per process).
 */
const FETCH_CACHE = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 128;

function fetchCacheKey(repo: Repo, args: FetchArgs, version: 'v2' | 'v0'): string {
  const deepenNotResolved = args.deepenNot.map(
    (ref) => repo.refs.get(ref) ?? (ref === 'HEAD' ? (repo.headSha() ?? ref) : ref),
  );
  return [
    version,
    repo.name,
    args.wants.join(','),
    args.haves.join(','),
    args.shallow.join(','),
    args.depth ?? '',
    deepenNotResolved.join(','),
  ].join('|');
}

function fetchCachePut(key: string, body: Buffer): void {
  if (FETCH_CACHE.size >= FETCH_CACHE_MAX) {
    const oldest = FETCH_CACHE.keys().next().value;
    if (oldest !== undefined) FETCH_CACHE.delete(oldest);
  }
  FETCH_CACHE.set(key, body);
}

function uploadPack(store: Store, repo: Repo, req: Req): Resp {
  void store;
  let packets: Pkt[];
  try {
    packets = pktDecode(req.body);
  } catch {
    return json(400, { message: 'malformed pkt-line stream' });
  }
  const first = packets.find((packet) => packet.kind === 'data');
  if (!first || first.kind !== 'data') return json(400, { message: 'empty upload-pack request' });
  const firstLine = first.data.toString('utf8');
  if (firstLine === 'command=ls-refs\n') return lsRefs(repo, packets);
  if (firstLine === 'command=fetch\n') return fetchV2(repo, packets);
  if (firstLine.startsWith('want ')) return fetchV0(repo, packets);
  return json(400, { message: 'unknown upload-pack command' });
}

// ---------------------------------------------------------------------------------------------
// POST git-receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function applyCommand(store: Store, repo: Repo, cmd: PushCommand): { ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = cmd;
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'ref does not exist' };
    if (oldOid !== current) return { ok: false, reason: 'stale old value' };
    repo.refs.delete(ref);
    return { ok: true, reason: '' };
  }
  const newObj = repo.objects.get(newOid);
  if (!newObj) return { ok: false, reason: 'missing object' };
  if (ref.startsWith('refs/heads/') && newObj.type !== 'commit') {
    return { ok: false, reason: 'invalid object type' };
  }
  if (ref.startsWith('refs/tags/') && newObj.type !== 'commit' && newObj.type !== 'tag') {
    return { ok: false, reason: 'invalid object type' };
  }
  if (current === undefined) {
    if (oldOid !== ZERO_OID) return { ok: false, reason: 'stale old value' };
    repo.refs.set(ref, newOid);
    return { ok: true, reason: '' };
  }
  if (oldOid !== current) return { ok: false, reason: 'stale old value' };
  const oldObj = repo.objects.get(oldOid);
  if (oldObj?.type === 'commit' && newObj.type === 'commit') {
    if (!store.isAncestor(repo, oldOid, newOid)) return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  return { ok: true, reason: '' };
}

function receivePack(store: Store, repo: Repo, req: Req): Resp {
  const body = req.body;
  const commands: PushCommand[] = [];
  const caps = new Set<string>();
  let off = 0;
  try {
    let first = true;
    for (;;) {
      if (off + 4 > body.length) throw new Error('truncated pkt-line');
      const head = body.subarray(off, off + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('invalid pkt-line length');
      const len = Number.parseInt(head, 16);
      if (len === 0) {
        off += 4;
        break;
      }
      if (len === 1 || len === 2) {
        off += 4;
        continue;
      }
      if (len === 3 || len > 65520) throw new Error('invalid pkt-line length');
      if (off + len > body.length) throw new Error('truncated pkt-line');
      let line = body.subarray(off + 4, off + len).toString('utf8');
      off += len;
      if (first) {
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          for (const token of line.slice(nul + 1).trim().split(/\s+/)) {
            if (token) caps.add(token.split('=')[0]);
          }
          line = line.slice(0, nul);
        }
        first = false;
      }
      const text = line.replace(/\n$/, '');
      const parts = text.split(' ');
      if (parts.length !== 3 || !HEX40.test(parts[0]) || !HEX40.test(parts[1]) || !parts[2].startsWith('refs/')) {
        throw new Error('bad receive-pack command');
      }
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  } catch (err) {
    return json(400, { message: err instanceof Error ? err.message : 'malformed receive-pack request' });
  }
  if (commands.length === 0) return json(400, { message: 'no receive-pack commands' });

  // Unpack the pack that follows the flush (absent for delete-only pushes).
  const packBytes = body.subarray(off);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail =
        (err instanceof Error ? err.message : 'unpack failed').replace(/[\r\n]+/g, ' ').slice(0, 200) ||
        'unpack failed';
    }
  }

  const lines: string[] = [];
  lines.push(unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`);
  for (const cmd of commands) {
    if (!unpackOk) {
      lines.push(`ng ${cmd.ref} ${unpackDetail}`);
      continue;
    }
    const result = applyCommand(store, repo, cmd);
    lines.push(result.ok ? `ok ${cmd.ref}` : `ng ${cmd.ref} ${result.reason}`);
  }

  const inner = Buffer.concat(lines.map((line) => pktLine(`${line}\n`)));
  let out: Buffer;
  if (caps.has('side-band-64k')) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < inner.length; offset += 32768) {
      const chunk = inner.subarray(offset, Math.min(inner.length, offset + 32768));
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    chunks.push(pktFlush());
    out = Buffer.concat(chunks);
  } else {
    out = Buffer.concat([inner, pktFlush()]);
  }
  return { status: 200, headers: { 'content-type': RECEIVE_RESULT_CT }, body: out };
}
