// git.ts — the git object model and wire framing for the forge.
//
// Everything here is stdlib only (node:crypto for SHA-1, node:zlib for pack
// streams). The object model is the plain git one: blobs, trees, commits and
// annotated tags, hashed as SHA-1 over "<type> <size>\0<data>", packed as
// PACK v2 with no deltas on the way out and full OFS/REF delta support on
// the way in. Pkt-lines frame the smart-HTTP protocol (v0 and v2) and the
// sideband channel carries packfiles and push reports.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

/** SHA-1 of a git object: hash("<type> <size>\0<data>"). */
export function hashObject(type: GitObjectType, data: Buffer | Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.from(`${type} ${body.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(body).digest('hex');
}

/** Whether `value` is a 40-hex object id. */
export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface PktLine {
  kind: PktKind;
  payload: Buffer;
}

/** Encode one pkt-line. `payload` is the line's bytes (a trailing \n included by the caller). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode a list of lines ('flush' / 'delim' are control packets). */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim' | Buffer)[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. Throws on a truncated or malformed frame. */
export function decodePktLines(buffer: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const text = buffer.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(text, 16);
    if (Number.isNaN(len) || len < 0 || len > 65520) throw new Error(`bad pkt-line length ${JSON.stringify(text)}`);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + len > buffer.length) throw new Error('truncated pkt-line payload');
    out.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + len)) });
    offset += len;
  }
  return out;
}

/** Split one sideband packet's payload into (band, data). Band 1 = pack, 2 = progress, 3 = error. */
export function sidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from([band]), data]);
  return pktLine(payload);
}

/** Chop `data` into sideband band-1 packets, each at most 65520 bytes on the wire. */
export function sidebandChunks(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxPayload = 65520 - 4 - 1;
  for (let offset = 0; offset < data.length; offset += maxPayload) {
    out.push(sidebandPacket(1, data.subarray(offset, Math.min(data.length, offset + maxPayload))));
  }
  if (out.length === 0) out.push(sidebandPacket(1, Buffer.alloc(0)));
  return out;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

export interface PackObject {
  type: GitObjectType;
  data: Buffer;
  oid: string;
}

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  let remaining = Math.floor(size / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a PACK v2 from plain objects (no deltas), trailer SHA-1 over all prior bytes. */
export function writePack(objects: readonly { type: GitObjectType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} does not match ${base.length}`);
  const targetSize = readSize();
  const out: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset = delta[offset++];
      if (op & 0x02) copyOffset |= delta[offset++] << 8;
      if (op & 0x04) copyOffset |= delta[offset++] << 16;
      if (op & 0x08) copyOffset |= delta[offset++] << 24;
      if (op & 0x10) copySize = delta[offset++];
      if (op & 0x20) copySize |= delta[offset++] << 8;
      if (op & 0x40) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base object');
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert runs past the delta');
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} bytes, expected ${targetSize}`);
  return Buffer.concat(out);
}

interface RawPackEntry {
  offset: number;
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Parse a packfile: verify the trailer, inflate every entry, resolve OFS/REF deltas. */
export function readPack(pack: Buffer, lookup?: (oid: string) => { type: GitObjectType; data: Buffer } | undefined): Map<string, PackObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not 2 or 3`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expected = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  const actual = pack.subarray(trailerStart).toString('hex');
  if (expected !== actual) throw new Error('pack trailer does not match its bytes');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry header is truncated');
      byte = pack[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack entry has unknown type code ${typeCode}`);
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 'ofs-delta') {
      if (offset >= trailerStart) throw new Error('ofs-delta offset is truncated');
      byte = pack[offset++];
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta offset is truncated');
        byte = pack[offset++];
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (type === 'ref-delta') {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base oid is truncated');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const written = inflated.engine.bytesWritten;
    if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
    if (inflated.buffer.length !== size) throw new Error(`pack entry declares ${size} bytes but inflated to ${inflated.buffer.length}`);
    offset += written;
    const entry: RawPackEntry = { offset: entryOffset, type, size, data: inflated.buffer, baseOffset, baseOid };
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, PackObject>();
  const resolved = new Map<number, PackObject>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): PackObject => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let result: PackObject;
    if (entry.type === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (baseEntry === undefined) throw new Error('ofs-delta base is outside the pack');
      const base = resolve(baseEntry);
      const data = applyDelta(base.data, entry.data);
      result = { type: base.type, data, oid: hashObject(base.type, data) };
    } else if (entry.type === 'ref-delta') {
      const baseOid = entry.baseOid ?? '';
      let base = objects.get(baseOid);
      if (base === undefined) {
        const found = lookup?.(baseOid);
        if (found !== undefined) base = { ...found, oid: baseOid };
      }
      if (base === undefined) {
        const baseEntry = raw.find((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && hashObject(candidate.type as GitObjectType, candidate.data) === baseOid);
        if (baseEntry !== undefined) base = resolve(baseEntry);
      }
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} is not in the pack or the store`);
      const data = applyDelta(base.data, entry.data);
      result = { type: base.type, data, oid: hashObject(base.type, data) };
    } else {
      result = { type: entry.type, data: entry.data, oid: hashObject(entry.type, entry.data) };
    }
    resolving.delete(entry.offset);
    resolved.set(entry.offset, result);
    objects.set(result.oid, result);
    return result;
  };
  for (const entry of raw) resolve(entry);
  return objects;
}

// ---------------------------------------------------------------------------
// trees, commits, tags
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries (in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry has no name or oid');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object. Entries are sorted the way git sorts them (dirs as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (tree === '') throw new Error('commit has no tree');
  return { tree, parents, author, committer, message };
}

/** Build a commit object. */
export function buildCommit(commit: ParsedCommit): Buffer {
  const lines: string[] = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

export interface ParsedTag {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build an annotated tag object. */
export function buildTag(tag: ParsedTag): Buffer {
  const lines = [`object ${tag.object}`, `type ${tag.type}`, `tag ${tag.tag}`];
  if (tag.tagger !== '') lines.push(`tagger ${tag.tagger}`);
  return Buffer.from(`${lines.join('\n')}\n\n${tag.message}`, 'utf8');
}
