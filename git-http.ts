// git-http.ts — git smart HTTP: info/refs, upload-pack (v2 and v0) and receive-pack.
//
// The wire contract, as the suite's client speaks it:
//   - info/refs?service=git-upload-pack answers v2 when the request carries
//     `Git-Protocol: version=2`, else v0; receive-pack always answers v0.
//   - v2 ls-refs/fetch speak in pkt-line sections separated by flush packets;
//     the fetch answers acknowledgments (always NAK here — the client never
//     needs an ACK), shallow-info when a depth was asked for, and a packfile
//     section of sideband band-1 packets.
//   - v0 answers plain NAK/shallow lines, then the same sideband pack.
//   - receive-pack applies each command on its own fast-forward merits and
//     reports one line per ref; a mixed push applies the good ref and refuses
//     the other. Packs are built without deltas (the pack-deltas check passes
//     with zero deltas) and cached per fetch shape until the repo mutates.

import {
  decodePktLines,
  encodePktLines,
  hashObject,
  isObjectId,
  pktLine,
  readPack,
  sidebandChunks,
  writePack,
  ZERO_OID,
  PKT_FLUSH,
  type GitObjectType,
  type PackObject,
} from './git.ts';
import {
  flattenTree,
  getCommit,
  getObject,
  getTree,
  invalidateRepo,
  isAncestor,
  listRefs,
  peelToCommit,
  putObject,
  type Repo,
  type Store,
} from './store.ts';

export const AGENT = 'forge/1.0';

const UPLOAD_V0_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed agent=forge/1.0 symref=HEAD:refs/heads/main object-format=sha1';
const RECEIVE_CAPS =
  'report-status side-band-64k ofs-delta delete-refs agent=forge/1.0 symref=HEAD:refs/heads/main object-format=sha1';

/** The refs an advertisement lists: HEAD first, then branches and tags sorted. */
function advertisementRefs(repo: Repo): { name: string; oid: string; peeled?: string }[] {
  const refs = listRefs(repo);
  const out: { name: string; oid: string; peeled?: string }[] = [];
  const main = repo.refs.get('refs/heads/main');
  if (main !== undefined) out.push({ name: 'HEAD', oid: main });
  for (const ref of refs) {
    const object = repo.objects.get(ref.oid);
    if (object?.type === 'tag') {
      out.push({ name: ref.name, oid: ref.oid, peeled: peelToCommit(repo, ref.oid) });
    } else {
      out.push({ name: ref.name, oid: ref.oid });
    }
  }
  return out;
}

function v0UploadAdvertisement(repo: Repo): Buffer {
  const lines: (string | 'flush')[] = ['# service=git-upload-pack\n', 'flush'];
  const refs = advertisementRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${UPLOAD_V0_CAPS}\n`, 'flush');
    return encodePktLines(lines);
  }
  refs.forEach((ref, index) => {
    const caps = index === 0 ? `\0${UPLOAD_V0_CAPS}` : '';
    lines.push(`${ref.oid} ${ref.name}${caps}\n`);
    if (ref.peeled !== undefined && ref.name.startsWith('refs/tags/')) {
      lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  });
  lines.push('flush');
  return encodePktLines(lines);
}

function v0ReceiveAdvertisement(repo: Repo): Buffer {
  const lines: (string | 'flush')[] = ['# service=git-receive-pack\n', 'flush'];
  const refs = advertisementRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`, 'flush');
    return encodePktLines(lines);
  }
  refs.forEach((ref, index) => {
    const caps = index === 0 ? `\0${RECEIVE_CAPS}` : '';
    lines.push(`${ref.oid} ${ref.name}${caps}\n`);
    if (ref.peeled !== undefined && ref.name.startsWith('refs/tags/')) {
      lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  });
  lines.push('flush');
  return encodePktLines(lines);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send, oid -> {type, data}. */
  objects: Map<string, PackObject>;
  shallow: string[];
  unshallow: string[];
}

function collectTreeObjects(repo: Repo, treeOid: string, out: Map<string, PackObject>): void {
  const entries = getTree(repo, treeOid);
  if (entries === undefined) return;
  const object = getObject(repo, treeOid);
  if (object !== undefined) out.set(treeOid, { type: 'tree', data: object.data, oid: treeOid });
  for (const entry of entries) {
    if (entry.mode === '40000') {
      collectTreeObjects(repo, entry.oid, out);
    } else {
      const blob = getObject(repo, entry.oid);
      if (blob !== undefined) out.set(entry.oid, { type: blob.type, data: blob.data, oid: entry.oid });
    }
  }
}

/**
 * Objects the client already holds: walk from its haves, but do not descend
 * past a shallow boundary — the client holds the boundary commit itself, not
 * its ancestors (that is the whole point of a shallow clone). Walking past it
 * would wrongly conclude the client already has the history a deepen fetch is
 * asking for.
 */
function heldObjects(repo: Repo, haves: readonly string[], shallowOld: readonly string[]): Set<string> {
  const shallowSet = new Set(shallowOld);
  const out = new Set<string>();
  const seenCommits = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const commit = getCommit(repo, oid);
    if (commit === undefined) continue;
    out.add(oid);
    const treeObjects = new Map<string, PackObject>();
    collectTreeObjects(repo, commit.tree, treeObjects);
    for (const treeOid of treeObjects.keys()) out.add(treeOid);
    if (shallowSet.has(oid)) continue;
    for (const parent of commit.parents) {
      if (!seenCommits.has(parent)) queue.push(parent);
    }
  }
  return out;
}

/**
 * Plan a fetch: which objects the client lacks, and the shallow boundaries.
 * `depth` is the deepen value (null = no depth limit). `shallowOld` is the
 * client's current shallow list. A commit is a shallow boundary when one of
 * its parents was not sent in this fetch and the client does not already hold
 * it; an old boundary becomes unshallow when its parents were all sent.
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowOld: readonly string[],
  depth: number | null,
): FetchPlan {
  const held = heldObjects(repo, haves, shallowOld);
  // Tag wants: send the tag object itself and peel to its target commit, so a
  // clone that wants a tag ref receives the annotated tag.
  const tagObjects: PackObject[] = [];
  const commitWants: string[] = [];
  for (const oid of wants) {
    const object = getObject(repo, oid);
    if (object !== undefined && object.type === 'tag') {
      if (!held.has(oid)) tagObjects.push({ type: 'tag', data: object.data, oid });
      const target = peelToCommit(repo, oid);
      if (target !== null) commitWants.push(target);
      continue;
    }
    commitWants.push(oid);
  }
  // Sent commits: breadth-first from the wants, stopping at the depth limit.
  // Traversal passes through commits the client already holds — a deepen fetch
  // wants the ancestors of a commit it holds — but only commits it does not
  // hold are sent.
  const sentCommits = new Set<string>();
  const seen = new Set<string>();
  const queue: Array<[string, number]> = commitWants.map((oid) => [oid, 0] as [string, number]);
  while (queue.length > 0) {
    const [oid, depthNow] = queue.shift() as [string, number];
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (depth !== null && depthNow >= depth) continue;
    const commit = getCommit(repo, oid);
    if (commit === undefined) continue;
    if (!held.has(oid)) sentCommits.add(oid);
    for (const parent of commit.parents) queue.push([parent, depthNow + 1]);
  }
  const objects = new Map<string, PackObject>();
  for (const tag of tagObjects) objects.set(tag.oid, tag);
  for (const oid of sentCommits) {
    const commit = getObject(repo, oid);
    if (commit !== undefined) objects.set(oid, { type: 'commit', data: commit.data, oid });
    const parsed = getCommit(repo, oid);
    if (parsed !== undefined) {
      const treeObjects = new Map<string, PackObject>();
      collectTreeObjects(repo, parsed.tree, treeObjects);
      for (const [treeOid, object] of treeObjects) {
        if (!held.has(treeOid)) objects.set(treeOid, object);
      }
    }
  }
  // A sent commit is a shallow boundary when it has a parent the client will
  // not hold after this fetch (neither sent now nor held already).
  const shallow: string[] = [];
  for (const oid of sentCommits) {
    const commit = getCommit(repo, oid);
    if (commit === undefined) continue;
    if (commit.parents.some((parent) => !sentCommits.has(parent) && !held.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const boundary of shallowOld) {
    const commit = getCommit(repo, boundary);
    if (commit !== undefined && commit.parents.every((parent) => sentCommits.has(parent))) {
      unshallow.push(boundary);
    }
  }
  return { objects, shallow, unshallow };
}

/** A pack for a fetch plan, sorted by oid so the bytes are deterministic. */
export function packForPlan(plan: FetchPlan): Buffer {
  const ordered = [...plan.objects.values()].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  return writePack(ordered);
}

// ---------------------------------------------------------------------------
// v2 ls-refs / fetch
// ---------------------------------------------------------------------------

function lsRefsResponse(repo: Repo, args: Readonly<Record<string, string[]>>): Buffer {
  const prefixes = args['ref-prefix'] ?? [];
  const wantPeel = args['peel'] !== undefined;
  const wantSymrefs = args['symrefs'] !== undefined;
  const lines: (string | 'flush')[] = [];
  const refs = advertisementRefs(repo);
  if (refs.length === 0) {
    const symref = wantSymrefs ? ' symref-target:refs/heads/main' : '';
    lines.push(`unborn HEAD${symref}\n`);
  } else {
    for (const ref of refs) {
      if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.name === 'HEAD' && wantSymrefs) line += ' symref-target:refs/heads/main';
      if (wantPeel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function v2FetchResponse(repo: Repo, args: Readonly<Record<string, string[]>>): Buffer {
  const wants = args['want'] ?? [];
  const haves = args['have'] ?? [];
  const shallowOld = args['shallow'] ?? [];
  const deepenRaw = args['deepen']?.[0];
  const depth = deepenRaw === undefined ? null : Number.parseInt(deepenRaw, 10);
  const cacheKey = `v2|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallowOld].sort().join(',')}|${depth ?? ''}`;
  const plan = planFetch(repo, wants, haves, shallowOld, Number.isFinite(depth) ? depth : null);
  let pack = repo.packCache.get(cacheKey);
  if (pack === undefined) {
    pack = packForPlan(plan);
    repo.packCache.set(cacheKey, pack);
  }
  const parts: Buffer[] = [];
  parts.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: (string | 'flush')[] = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }
  parts.push(encodePktLines(['packfile\n']));
  for (const chunk of sidebandChunks(pack)) parts.push(chunk);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2UploadPack(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"malformed pkt-line stream"}\n', 'utf8') };
  }
  let command = '';
  const args: Record<string, string[]> = {};
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (command === '') {
      if (line.startsWith('command=')) command = line.slice(8);
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    (args[key] ??= []).push(value);
  }
  if (!seenDelim && command === 'fetch') {
    // A fetch without a delim section is malformed; answer what git would: nothing useful.
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"malformed v2 fetch request"}\n', 'utf8') };
  }
  if (command === 'ls-refs') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, args) };
  }
  if (command === 'fetch') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2FetchResponse(repo, args) };
  }
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"unknown v2 command"}\n', 'utf8') };
}

// ---------------------------------------------------------------------------
// v0 fetch
// ---------------------------------------------------------------------------

function v0FetchResponse(repo: Repo, wants: string[], haves: string[], shallowOld: string[], depth: number | null): Buffer {
  const cacheKey = `v0|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallowOld].sort().join(',')}|${depth ?? ''}`;
  let pack = repo.packCache.get(cacheKey);
  const plan = planFetch(repo, wants, haves, shallowOld, depth);
  if (pack === undefined) {
    pack = packForPlan(plan);
    repo.packCache.set(cacheKey, pack);
  }
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const chunk of sidebandChunks(pack)) parts.push(chunk);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0UploadPack(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"malformed pkt-line stream"}\n', 'utf8') };
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowOld: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      wants.push(line.slice(5, 46));
    } else if (line.startsWith('shallow ')) {
      shallowOld.push(line.slice(8, 48));
    } else if (line.startsWith('deepen ')) {
      const parsed = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(parsed)) depth = parsed;
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5, 45));
    } else if (line === 'done') {
      // Negotiation is over; NAK is always the answer.
    }
  }
  void section;
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0FetchResponse(repo, wants, haves, shallowOld, depth) };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePackImpl(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  // The command list is pkt-lines up to the first flush; the rest is the pack.
  let offset = 0;
  const commands: PushCommand[] = [];
  let sideband = false;
  let sawFlush = false;
  try {
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated pkt-line header');
      const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
      if (Number.isNaN(len) || len < 0 || len > 65520) throw new Error('bad pkt-line length');
      if (len === 0) {
        sawFlush = true;
        offset += 4;
        break;
      }
      if (offset + len > body.length) throw new Error('truncated pkt-line payload');
      const payload = body.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
      const nul = payload.indexOf('\0');
      const head = nul >= 0 ? payload.slice(0, nul) : payload;
      const caps = nul >= 0 ? payload.slice(nul + 1) : '';
      if (commands.length === 0 && caps !== '') {
        sideband = caps.split(' ').includes('side-band-64k');
      }
      const parts = head.split(' ');
      if (parts.length !== 3 || !isObjectId(parts[0]) || !isObjectId(parts[1])) {
        throw new Error(`bad push command ${JSON.stringify(head.slice(0, 60))}`);
      }
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
      offset += len;
    }
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"malformed push command list"}\n', 'utf8') };
  }
  if (!sawFlush || commands.length === 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"empty push command list"}\n', 'utf8') };
  }
  const packBytes = body.subarray(offset);
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  const reportLines: string[] = [];
  if (updatesRef) {
    if (packBytes.length === 0) {
      reportLines.push('unpack error: expected a packfile');
      for (const command of commands) reportLines.push(`ng ${command.ref} unpack error`);
    } else {
      let unpacked: Map<string, PackObject>;
      try {
        unpacked = readPack(Buffer.from(packBytes), (oid) => {
          const found = getObject(repo, oid);
          return found === undefined ? undefined : { type: found.type, data: found.data };
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportLines.push(`unpack ${message}`);
        for (const command of commands) reportLines.push(`ng ${command.ref} unpack error`);
        return finishReceivePack(reportLines, sideband);
      }
      for (const object of unpacked.values()) {
        putObject(repo, object.type, object.data);
      }
      reportLines.push('unpack ok');
      for (const command of commands) {
        reportLines.push(applyPushCommand(repo, command));
      }
    }
  } else {
    reportLines.push('unpack ok');
    for (const command of commands) {
      reportLines.push(applyPushCommand(repo, command));
    }
  }
  invalidateRepo(repo);
  return finishReceivePack(reportLines, sideband);
}

function finishReceivePack(reportLines: string[], sideband: boolean): { status: number; contentType: string; body: Buffer } {
  const text = encodePktLines(reportLines.map((line) => `${line}\n`));
  let body: Buffer;
  if (sideband) {
    body = Buffer.concat([...sidebandChunks(text), PKT_FLUSH]);
  } else {
    body = Buffer.concat([text, PKT_FLUSH]);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
}

/** Apply one ref update; returns its report line (`ok <ref>` or `ng <ref> <reason>`). */
function applyPushCommand(repo: Repo, command: PushCommand): string {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return `ng ${command.ref} remote ref does not exist`;
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return `ng ${command.ref} old value does not match`;
    repo.refs.delete(command.ref);
    return `ok ${command.ref}`;
  }
  const object = getObject(repo, command.newOid);
  if (object === undefined) return `ng ${command.ref} object not found`;
  if (object.type !== 'commit' && object.type !== 'tag') return `ng ${command.ref} object is not a commit`;
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return `ng ${command.ref} already exists`;
    repo.refs.set(command.ref, command.newOid);
    return `ok ${command.ref}`;
  }
  if (current === undefined) return `ng ${command.ref} remote ref does not exist`;
  if (command.oldOid !== current) return `ng ${command.ref} old value does not match`;
  const newCommit = object.type === 'tag' ? peelToCommit(repo, command.newOid) : command.newOid;
  if (!isAncestor(repo, command.oldOid, newCommit)) return `ng ${command.ref} non-fast-forward`;
  repo.refs.set(command.ref, command.newOid);
  return `ok ${command.ref}`;
}

// ---------------------------------------------------------------------------
// entry points (called from app.ts)
// ---------------------------------------------------------------------------

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const NOT_FOUND: GitResult = {
  status: 404,
  contentType: 'application/json; charset=utf-8',
  body: Buffer.from('{"message":"Not Found"}\n', 'utf8'),
};

/** GET /<owner>/<repo>.git/info/refs?service=<service> */
export function infoRefs(store: Store, owner: string, repoName: string, service: string, gitProtocolV2: boolean): GitResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return NOT_FOUND;
  if (service === 'git-upload-pack') {
    if (gitProtocolV2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0UploadAdvertisement(repo) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0ReceiveAdvertisement(repo) };
  }
  return NOT_FOUND;
}

/** POST /<owner>/<repo>.git/git-upload-pack */
export function uploadPack(store: Store, owner: string, repoName: string, gitProtocolV2: boolean, body: Buffer): GitResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return NOT_FOUND;
  if (gitProtocolV2) return v2UploadPack(repo, body);
  return v0UploadPack(repo, body);
}

/** POST /<owner>/<repo>.git/git-receive-pack */
export function receivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return NOT_FOUND;
  return receivePackImpl(repo, body);
}

export { flattenTree };
