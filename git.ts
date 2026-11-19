// git.ts — git smart HTTP: protocol v2 and v0, spoken in pure Node stdlib.
//
// The trial pod has no git binary, so the pack protocol lives here: pkt-line
// framing, ref advertisements, ls-refs, fetch (with shallow/deepen) and
// receive-pack with per-ref report-status. Packs sent are plain objects only —
// the client resolves deltas fine, but never needs them from us.

import {
  ZERO_OID,
  collectReachable,
  collectShallow,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelObject,
  readPack,
  writePack,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length + 4 > 65520) throw new Error('pkt-line too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function pktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer into packets. Throws on malformed framing. */
export function decodePktLines(buf: Buffer): Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload?: Buffer }> {
  const out: Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload?: Buffer }> = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const header = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      off += 4;
    } else if (length === 1) {
      out.push({ kind: 'delim' });
      off += 4;
    } else if (length === 2) {
      out.push({ kind: 'response-end' });
      off += 4;
    } else {
      if (off + length > buf.length) throw new Error('truncated pkt-line');
      out.push({ kind: 'data', payload: buf.subarray(off + 4, off + length) });
      off += length;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function tagPeel(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  return peelObject(repo.objects, oid);
}

/** All refs plus HEAD, as ls-refs / advertisements report them. */
export function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(defaultRef);
  if (headTip) {
    out.push({ oid: headTip, name: 'HEAD', symrefTarget: defaultRef });
  } else {
    out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: defaultRef, unborn: true });
  }
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name)!;
    const peeled = tagPeel(repo, oid);
    out.push(peeled ? { oid, name, peeled } : { oid, name });
  }
  return out;
}

const V2_CAPABILITIES: Array<[string, string]> = [
  ['agent', 'git-forge/1.0'],
  ['ls-refs', 'unborn'],
  ['fetch', 'shallow filter'],
  ['object-format', 'sha1'],
];

const V0_UPLOAD_CAPS = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=git-forge/1.0';
const V0_RECEIVE_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=git-forge/1.0';

// ---------------------------------------------------------------------------
// Advertisements (GET /info/refs)
// ---------------------------------------------------------------------------

export function uploadPackAdvertisement(repo: Repo, version2: boolean): Buffer {
  if (version2) {
    const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush', 'version 2\n'];
    for (const [key, value] of V2_CAPABILITIES) lines.push(`${key}=${value}\n`);
    lines.push('flush');
    return pktLines(lines);
  }
  const caps = V0_UPLOAD_CAPS.replace('symref=HEAD:refs/heads/main', `symref=HEAD:refs/heads/${repo.defaultBranch}`);
  const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush'];
  const refs = listRefs(repo).filter((ref) => ref.name !== 'HEAD');
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (headTip) lines.push(`${headTip} HEAD\0${caps}\n`);
    else lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

export function receivePackAdvertisement(repo: Repo): Buffer {
  const lines: Array<string | 'flush'> = ['# service=git-receive-pack\n', 'flush'];
  const refs = listRefs(repo).filter((ref) => ref.name !== 'HEAD');
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${V0_RECEIVE_CAPS}\n`);
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (headTip) lines.push(`${headTip} HEAD\0${V0_RECEIVE_CAPS}\n`);
    else lines.push(`${ZERO_OID} capabilities^{}\0${V0_RECEIVE_CAPS}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

export function lsRefsResponse(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data' || !packet.payload) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  for (const ref of listRefs(repo)) {
    if (!keep(ref.name)) continue;
    if (ref.unborn) {
      out.push(`unborn ${ref.name}${ref.symrefTarget && symrefs ? ` symref-target:${ref.symrefTarget}` : ''}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.symrefTarget && symrefs) line += ` symref-target:${ref.symrefTarget}`;
    if (ref.peeled && peel) line += ` peeled:${ref.peeled}`;
    out.push(`${line}\n`);
  }
  out.push('flush' as never);
  return pktLines(out as unknown as Array<string | 'flush'>);
}

// ---------------------------------------------------------------------------
// Fetch (upload-pack, v2 and v0)
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseV2FetchBody(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data' || !packet.payload) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  return req;
}

function parseV0FetchBody(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data' || !packet.payload) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const first = line.slice(5).split(' ')[0]!;
      if (isOid(first)) req.wants.push(first);
    } else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  return req;
}

/** The objects a fetch sends, plus the shallow boundary it reports. */
function planFetch(
  repo: Repo,
  req: FetchRequest,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const haveSet = collectReachable(req.haves, lookup, new Set(req.shallow));
  let send: Set<string>;
  let shallow: string[] = [];
  const unshallow: string[] = [];
  if (req.depth !== null && Number.isFinite(req.depth) && req.depth > 0) {
    const { included, boundary } = collectShallow(req.wants, lookup, req.depth);
    send = new Set([...included].filter((oid) => !haveSet.has(oid)));
    shallow = [...boundary].filter((oid) => send.has(oid) || included.has(oid));
    // A previous boundary that is now inside the fetched range is unshallowed.
    for (const old of req.shallow) {
      if (included.has(old) && !boundary.has(old)) unshallow.push(old);
    }
  } else {
    const wantSet = collectReachable(req.wants, lookup);
    send = new Set([...wantSet].filter((oid) => !haveSet.has(oid)));
  }
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow, unshallow };
}

/** Pack bytes as sideband band-1 pkt-lines (each packet <= 65520 bytes raw). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

export function fetchV2Response(repo: Repo, body: Buffer): Buffer {
  const req = parseV2FetchBody(body);
  const { objects, shallow, unshallow } = planFetch(repo, req);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client negotiated with
  // "have" lines; a fresh clone (no haves) expects "packfile" first — a real
  // git server behaves exactly this way.
  if (req.haves.length > 0) {
    parts.push(pktLines(['acknowledgments\n', 'NAK\n', 'ready\n', 'delim']));
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(pktLines(lines));
  }
  parts.push(pktLines(['packfile\n']));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function fetchV0Response(repo: Repo, body: Buffer): Buffer {
  const req = parseV0FetchBody(body);
  const { objects, shallow, unshallow } = planFetch(repo, req);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Receive-pack (push, v0 only)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  // The command list is pkt-lines up to the first flush; the rest is the pack.
  const packets: Array<{ kind: string; payload?: Buffer; rawEnd: number }> = [];
  let off = 0;
  let packStart = body.length;
  while (off < body.length) {
    if (off + 4 > body.length) throw new Error('truncated pkt-line in push');
    const header = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('bad pkt-line in push');
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packStart = off + 4;
      break;
    }
    if (length === 1 || length === 2) {
      off += 4;
      continue;
    }
    if (off + length > body.length) throw new Error('truncated pkt-line in push');
    packets.push({ kind: 'data', payload: body.subarray(off + 4, off + length), rawEnd: off + length });
    off += length;
  }
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (!packet.payload) continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) {
      throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, pack: body.subarray(packStart) };
}

export function receivePackResponse(repo: Repo, body: Buffer): Buffer {
  const reportLines: string[] = [];
  let unpackOk = true;
  try {
    const { commands, pack } = parsePushBody(body);
    const needsPack = commands.some((cmd) => cmd.newOid !== ZERO_OID);
    let unpacked: Map<string, GitObject> = new Map();
    if (needsPack) {
      if (pack.length === 0) throw new Error('missing packfile');
      unpacked = readPack(pack);
      for (const [oid, obj] of unpacked) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    }
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (!current) {
          reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          reportLines.push(`ng ${cmd.ref} old value does not match\n`);
        } else {
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} object not found\n`);
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        if (current) {
          reportLines.push(`ng ${cmd.ref} already exists\n`);
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      if (current !== cmd.oldOid) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (!isAncestor(repo.objects, cmd.oldOid, cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}\n`);
    }
  } catch (err) {
    unpackOk = false;
    reportLines.length = 0;
    reportLines.push(`unpack error ${err instanceof Error ? err.message : 'unpack failed'}\n`);
    // A failed unpack refuses every command the client sent (best effort: re-parse names).
    try {
      const { commands } = parsePushBody(body);
      for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpacker error\n`);
    } catch {
      // Nothing more to report.
    }
  }
  const inner: Array<string | 'flush'> = [unpackOk ? 'unpack ok\n' : reportLines.shift()!, ...reportLines, 'flush'];
  const innerFramed = pktLines(inner);
  // The report-status stream rides inside sideband band 1.
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < innerFramed.length; off += CHUNK) {
    const slice = innerFramed.subarray(off, Math.min(innerFramed.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Small git helpers shared with the REST layer
// ---------------------------------------------------------------------------

export function commitSummary(objects: Map<string, GitObject>, oid: string): { message: string; tree: string } | null {
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  return { message: view.message, tree: view.tree };
}

export function objectExists(store: Store, owner: string, name: string, oid: string): boolean {
  const repo = store.getRepo(owner, name);
  return repo?.objects.has(oid) ?? false;
}

export { hashObject, parseTree };
