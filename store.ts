// store.ts — the forge's whole state: git objects, refs, issues, pull requests.
//
// Everything lives in memory. The trial pod mounts /bot read-only and gives the
// entry no database, so a Map-backed store is the honest shape: fast, deterministic
// and gone when the process exits. No wall clock is read anywhere here: a logical
// counter seeded from MAKEFUN_TRIAL_NOW (or a fixed epoch) stamps every commit,
// issue and pull request, so a live run and its replay produce the same bytes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

/** The login the suite's bearer token names (wire.ts's fixed scenario seed). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

// ---------------------------------------------------------------------------
// Deterministic clock
// ---------------------------------------------------------------------------

function trialBaseEpoch(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  }
  return 1700000000;
}

const BASE_EPOCH = trialBaseEpoch();
let tick = 0;

/** The next logical second. Monotonic, deterministic, never the wall clock. */
export function nextEpochSec(): number {
  tick += 1;
  return BASE_EPOCH + tick;
}

export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Global (Relay-style) ids: opaque, stable, decodable by this server only.
// ---------------------------------------------------------------------------

export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

export function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < buf.length) {
    const space = buf.indexOf(0x20, off);
    const nul = buf.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > buf.length) throw new Error('malformed tree object');
    entries.push({
      mode: buf.subarray(off, space).toString('ascii'),
      name: buf.subarray(space + 1, nul).toString('utf8'),
      oid: buf.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headerText = buf.subarray(0, blank < 0 ? buf.length : blank).toString('utf8');
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of buf.subarray(0, blank < 0 ? buf.length : blank).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes with the viewer's identity and a logical timestamp. */
export function buildCommitBytes(tree: string, parents: readonly string[], message: string, epochSec: number): Buffer {
  const who = `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message.endsWith('\n') ? message : `${message}\n`}`, 'utf8');
}

/** Peel an annotated tag chain to the commit (or object) it finally names. */
export function peelObject(objects: Map<string, GitObject>, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const obj = objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from `roots` (commits, trees, blobs, tags). */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup, stopAt?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots].filter(isOid);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
      // A shallow boundary commit is held by the client, but not its
      // parents: a deepen must still deliver them.
      if (stopAt?.has(oid)) continue;
      for (const parent of commit.parents) queue.push(parent);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * Reachable objects within a depth limit, for shallow fetches. Commit distance 0 is
 * the wanted tip; commits closer than `depth` are included with their trees and blobs.
 * Returns the included object ids and the boundary commits (distance depth-1).
 */
export function collectShallow(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  depth: number,
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) {
    if (!isOid(root)) continue;
    queue.push({ oid: root, depth: 0 });
  }
  const visitNonCommit = (oid: string): void => {
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (included.has(current)) continue;
      const obj = lookup(current);
      if (!obj) continue;
      included.add(current);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  };
  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift()!;
    const known = commitDepth.get(oid);
    if (known !== undefined && known <= d) continue;
    commitDepth.set(oid, d);
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      queue.push({ oid: parseTag(obj.data).object, depth: d });
      included.add(oid);
      continue;
    }
    if (obj.type !== 'commit') {
      visitNonCommit(oid);
      continue;
    }
    if (d >= depth) continue;
    included.add(oid);
    if (d === depth - 1) boundary.add(oid);
    const commit = parseCommit(obj.data);
    visitNonCommit(commit.tree);
    for (const parent of commit.parents) queue.push({ oid: parent, depth: d + 1 });
  }
  return { included, boundary };
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return false;
}

/** The best common ancestor of two commits (first-parent walk order). */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const bAncestors = new Set<string>();
  const queueB = [b];
  while (queueB.length > 0) {
    const oid = queueB.pop()!;
    if (bAncestors.has(oid)) continue;
    bAncestors.add(oid);
    const obj = objects.get(oid);
    if (obj?.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queueB.push(parent);
    } else if (obj?.type === 'tag') {
      queueB.push(parseTag(obj.data).object);
    }
  }
  const queueA = [a];
  const seenA = new Set<string>();
  while (queueA.length > 0) {
    const oid = queueA.shift()!;
    if (bAncestors.has(oid)) return oid;
    if (seenA.has(oid)) continue;
    seenA.add(oid);
    const obj = objects.get(oid);
    if (obj?.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queueA.push(parent);
    } else if (obj?.type === 'tag') {
      queueA.push(parseTag(obj.data).object);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Packfiles (plain objects on write; deltas resolved on read)
// ---------------------------------------------------------------------------

function readPackVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buf[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[off++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, off, off + literal);
      off += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Parse a packfile into objects, resolving OFS/REF deltas. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as Raw & { _resolved?: { type: GitObjectType; data: Buffer; oid: string } })._resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (!baseEntry) throw new Error('ref-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as Raw & { _resolved?: unknown })._resolved = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
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

/** Build a packfile from plain objects (no deltas), trailer checksummed. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// Trees as flat path maps (for contents, diffs and merges)
// ---------------------------------------------------------------------------

export type FileMap = Map<string, { oid: string; mode: string }>;

/** Flatten a tree object (recursively) into path -> blob. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix = ''): FileMap {
  const out: FileMap = new Map();
  const walk = (oid: string, base: string): void => {
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build (and store) nested tree objects from a flat path map; returns the root tree oid. */
export function storeTreeFromFiles(objects: Map<string, GitObject>, files: FileMap): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!objects.has(oid)) objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Line-level diff counts between two texts (LCS on lines). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS lengths with two rolling rows.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  const common = prev[m];
  return { additions: m - common, deletions: n - common };
}

/** Diff two file maps: added / removed / modified paths with line counts. */
export function diffFileMaps(
  objects: Map<string, GitObject>,
  base: FileMap,
  head: FileMap,
): Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> {
  const out: Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const oldText = objects.get(b.oid)?.data.toString('utf8') ?? '';
      const counts = lineDiffCounts(oldText, '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
    } else if (!b && h) {
      const newText = objects.get(h.oid)?.data.toString('utf8') ?? '';
      const counts = lineDiffCounts('', newText);
      out.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = objects.get(h.oid)?.data.toString('utf8') ?? '';
      const counts = lineDiffCounts(oldText, newText);
      out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
    }
  }
  return out;
}

/**
 * Three-way merge of file maps: base (merge-base), head (the PR branch), current
 * (the base branch tip now). Returns the merged map, or null on conflict.
 */
export function threeWayMerge(base: FileMap, head: FileMap, current: FileMap): FileMap | null {
  const merged: FileMap = new Map(current);
  const paths = new Set([...base.keys(), ...head.keys(), ...current.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const c = current.get(path);
    const headChanged = (h?.oid ?? null) !== (b?.oid ?? null);
    const currentChanged = (c?.oid ?? null) !== (b?.oid ?? null);
    if (!headChanged) continue;
    if (!currentChanged) {
      if (h) merged.set(path, h);
      else merged.delete(path);
      continue;
    }
    if ((h?.oid ?? null) === (c?.oid ?? null)) continue;
    return null;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// The forge's entities
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  globalId: string;
  body: string;
  userLogin: string;
  createdAt: string;
  seq: number;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
  comments: IssueComment[];
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  dbId: number;
  globalId: string;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  createdAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextIssue: number;
  nextPull: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private commentSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, opts: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo {
    this.repoSeq += 1;
    const epoch = nextEpochSec();
    const repo: Repo = {
      dbId: this.repoSeq,
      globalId: gid('repo', owner, name),
      owner,
      name,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      seq: this.repoSeq,
      createdAt: isoOf(epoch),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.seq - b.seq);
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  /** The tip commit of a ref, or null when the ref is unborn. */
  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** Resolve a branch name, full ref or sha to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/heads/')) return repo.refs.get(ref) ?? null;
    if (ref.startsWith('refs/tags/')) {
      const oid = repo.refs.get(ref);
      if (!oid) return null;
      return peelObject(repo.objects, oid);
    }
    return repo.refs.get(`refs/heads/${ref}`) ?? null;
  }

  /** Create a commit on `branch` (creating the branch from the default tip when needed). */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string } {
    const blobSha = hashObject('blob', content);
    if (!repo.objects.has(blobSha)) repo.objects.set(blobSha, { type: 'blob', data: content });
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    let parentTree: FileMap = new Map();
    const parents: string[] = [];
    if (tip) {
      const commit = parseCommit(repo.objects.get(tip)!.data);
      parentTree = flattenTree(repo.objects, commit.tree);
      parents.push(tip);
    } else {
      // A new branch starts from the default branch tip, when there is one.
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip && branch !== repo.defaultBranch) {
        const commit = parseCommit(repo.objects.get(defaultTip)!.data);
        parentTree = flattenTree(repo.objects, commit.tree);
        parents.push(defaultTip);
      }
    }
    const files: FileMap = new Map(parentTree);
    files.set(path, { oid: blobSha, mode: '100644' });
    const treeOid = storeTreeFromFiles(repo.objects, files);
    const epoch = nextEpochSec();
    const commitData = buildCommitBytes(treeOid, parents, message, epoch);
    const commitSha = hashObject('commit', commitData);
    repo.objects.set(commitSha, { type: 'commit', data: commitData });
    repo.refs.set(refName, commitSha);
    return { commitSha, blobSha };
  }

  /** Delete a file on the default branch (or `branch`), committing the removal. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    if (!tip) return null;
    const commit = parseCommit(repo.objects.get(tip)!.data);
    const files = flattenTree(repo.objects, commit.tree);
    if (!files.has(path)) return null;
    files.delete(path);
    const treeOid = storeTreeFromFiles(repo.objects, files);
    const epoch = nextEpochSec();
    const commitData = buildCommitBytes(treeOid, [tip], message, epoch);
    const commitSha = hashObject('commit', commitData);
    repo.objects.set(commitSha, { type: 'commit', data: commitData });
    repo.refs.set(refName, commitSha);
    return { commitSha };
  }

  /** Commits reachable from `tip`, newest first (by creation order). */
  listCommits(repo: Repo, tip: string): Array<{ sha: string; commit: CommitView; seq: number }> {
    const reachable = collectReachable([tip], (oid) => repo.objects.get(oid));
    const commits: Array<{ sha: string; commit: CommitView; seq: number }> = [];
    // Order by the commit's own logical timestamp: the author line carries it.
    for (const oid of reachable) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const view = parseCommit(obj.data);
      const stamp = Number(view.author.split(' ').slice(-2, -1)[0] ?? 0);
      commits.push({ sha: oid, commit: view, seq: Number.isFinite(stamp) ? stamp : 0 });
    }
    commits.sort((a, b) => b.seq - a.seq);
    return commits;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextIssue;
    repo.nextIssue += 1;
    const epoch = nextEpochSec();
    const issue: Issue = {
      id: gid('issue', repo.owner, repo.name, number),
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      userLogin: VIEWER.login,
      createdAt: isoOf(epoch),
      updatedAt: isoOf(epoch),
      closedAt: null,
      seq: epoch,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    headSha: string,
    baseRef: string,
    baseSha: string,
  ): PullRequest {
    const number = repo.nextPull;
    repo.nextPull += 1;
    const epoch = nextEpochSec();
    const pull: PullRequest = {
      id: gid('pull', repo.owner, repo.name, number),
      number,
      title,
      body: body ?? '',
      state: 'open',
      headRef,
      headSha,
      baseRef,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      userLogin: VIEWER.login,
      createdAt: isoOf(epoch),
      updatedAt: isoOf(epoch),
      seq: epoch,
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge sha, or null on conflict. */
  squashMerge(repo: Repo, pull: PullRequest): string | null {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headTip || !baseTip) return null;
    const base = mergeBase(repo.objects, headTip, baseTip);
    const baseTree = base ? flattenTree(repo.objects, parseCommit(repo.objects.get(base)!.data).tree) : new Map<string, { oid: string; mode: string }>();
    const headTree = flattenTree(repo.objects, parseCommit(repo.objects.get(headTip)!.data).tree);
    const currentTree = flattenTree(repo.objects, parseCommit(repo.objects.get(baseTip)!.data).tree);
    const merged = threeWayMerge(baseTree, headTree, currentTree);
    if (merged === null) return null;
    const treeOid = storeTreeFromFiles(repo.objects, merged);
    const epoch = nextEpochSec();
    const message = `${pull.title} (#${pull.number})`;
    const commitData = buildCommitBytes(treeOid, [baseTip], message, epoch);
    const mergeSha = hashObject('commit', commitData);
    repo.objects.set(mergeSha, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoOf(epoch);
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = isoOf(epoch);
    return mergeSha;
  }

  /** Whether a pull request merges cleanly right now (three-way, no commit). */
  pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!headTip || !baseTip) return 'UNKNOWN';
    if (pull.merged) return 'UNKNOWN';
    const base = mergeBase(repo.objects, headTip, baseTip);
    const baseTree = base ? flattenTree(repo.objects, parseCommit(repo.objects.get(base)!.data).tree) : new Map<string, { oid: string; mode: string }>();
    const headTree = flattenTree(repo.objects, parseCommit(repo.objects.get(headTip)!.data).tree);
    const currentTree = flattenTree(repo.objects, parseCommit(repo.objects.get(baseTip)!.data).tree);
    return threeWayMerge(baseTree, headTree, currentTree) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** The changed files of a pull request (merge-base tree vs head tree). */
  pullFiles(repo: Repo, pull: PullRequest): ReturnType<typeof diffFileMaps> {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = mergeBase(repo.objects, headTip, baseTip);
    const baseTree = base ? flattenTree(repo.objects, parseCommit(repo.objects.get(base)!.data).tree) : new Map<string, { oid: string; mode: string }>();
    const headTree = flattenTree(repo.objects, parseCommit(repo.objects.get(headTip)!.data).tree);
    return diffFileMaps(repo.objects, baseTree, headTree);
  }
}
