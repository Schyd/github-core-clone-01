// store.ts — the forge's in-memory store.
//
// One process, one store, no persistence: a trial starts the entry fresh and
// the suite builds every fixture through the API, so nothing needs to survive
// a restart. All data is deterministic: commit timestamps and created_at
// values come from a monotonic counter seeded at a fixed epoch, never from
// the wall clock, so a replay of the same requests leaves the same state.
//
// The viewer is the login the trial's bearer token names (wire.ts's seeded
// scenario: adaiversen). Any non-empty Bearer token is that viewer; the
// stranger (olgabauer) owns nothing here, so the same name under another
// owner is a 404, never a 403.

import {
  buildCommit,
  buildTag,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObjectType,
  type ParsedCommit,
  type TreeEntry,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  createdSeq: number;
}

export interface Repo {
  dbid: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, { type: GitObjectType; data: Buffer }>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
  commitCache: Map<string, ParsedCommit>;
  treeCache: Map<string, TreeEntry[]>;
  tagCache: Map<string, { object: string; type: GitObjectType }>;
  packCache: Map<string, Buffer>;
  issueJson: Map<number, string>;
  repoJson: string | null;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  /** Deterministic clock: seconds since epoch, advanced one step per timestamp taken. */
  seq = 1_700_000_000;
  nextDbid = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextGlobalCommentId = 1;
  requestSeq = 0;

  tick(): number {
    const now = this.seq;
    this.seq += 1;
    return now;
  }

  iso(sec: number): string {
    return new Date(sec * 1000).toISOString();
  }

  /** The identity server-created commits carry. */
  identity(): { name: string; email: string; stamp: string } {
    const sec = this.tick();
    return { name: VIEWER_LOGIN, email: VIEWER_EMAIL, stamp: `${sec} +0000` };
  }

  requestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      dbid: this.nextDbid++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.tick(),
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextCommentId: 1,
      commitCache: new Map(),
      treeCache: new Map(),
      tagCache: new Map(),
      packCache: new Map(),
      issueJson: new Map(),
      repoJson: null,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Every repository the viewer owns, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER_LOGIN) out.push(repo);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// objects, commits, trees
// ---------------------------------------------------------------------------

/** Store one object; returns its oid. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): { type: GitObjectType; data: Buffer } | undefined {
  return repo.objects.get(oid);
}

export function getCommit(repo: Repo, oid: string): ParsedCommit | undefined {
  const cached = repo.commitCache.get(oid);
  if (cached !== undefined) return cached;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return undefined;
  const parsed = parseCommit(object.data);
  repo.commitCache.set(oid, parsed);
  return parsed;
}

export function getTree(repo: Repo, oid: string): TreeEntry[] | undefined {
  const cached = repo.treeCache.get(oid);
  if (cached !== undefined) return cached;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tree') return undefined;
  const parsed = parseTree(object.data);
  repo.treeCache.set(oid, parsed);
  return parsed;
}

/** Peel an annotated tag to the commit it names (or the oid itself when it is not a tag). */
export function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 8; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    const cached = repo.tagCache.get(current);
    if (cached !== undefined) {
      current = cached.object;
      continue;
    }
    const parsed = parseTag(object.data);
    repo.tagCache.set(current, { object: parsed.object, type: parsed.type });
    current = parsed.object;
  }
  return current;
}

/** Resolve a branch name, a full ref, or a raw oid to a commit oid. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (ref === '') return null;
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const object = repo.objects.get(ref.toLowerCase());
    return object !== undefined ? ref.toLowerCase() : null;
  }
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const head = repo.refs.get(`refs/heads/${ref}`);
  if (head !== undefined) return head;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  return null;
}

/** All refs, branches then tags, each sorted by name. */
export function listRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** Commits reachable from `tip`, newest first (parents after children), de-duplicated. */
export function walkCommits(repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (commit === undefined) continue;
    order.push(oid);
    for (const parent of commit.parents) {
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return order;
}

/** Whether `ancestor` is reachable from `descendant` (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (commit === undefined) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return false;
}

/** The merge-base of two tips: the common ancestor closest to both (BFS depth). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const depthA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, depth] = queueA.shift() as [string, number];
    if (depthA.has(oid)) continue;
    depthA.set(oid, depth);
    const commit = getCommit(repo, oid);
    if (commit === undefined) continue;
    for (const parent of commit.parents) queueA.push([parent, depth + 1]);
  }
  let best: string | null = null;
  let bestScore = Infinity;
  const seenB = new Set<string>();
  const queueB: Array<[string, number]> = [[b, 0]];
  while (queueB.length > 0) {
    const [oid, depth] = queueB.shift() as [string, number];
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const depthInA = depthA.get(oid);
    if (depthInA !== undefined) {
      const score = depthInA + depth;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    const commit = getCommit(repo, oid);
    if (commit === undefined) continue;
    for (const parent of commit.parents) queueB.push([parent, depth + 1]);
  }
  return best;
}

/** Flatten a tree into path -> {oid, mode}, recursively. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const entries = getTree(repo, treeOid);
  if (entries === undefined) return out;
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/**
 * Return a new root tree with `path` set to `blobOid` (or removed when null),
 * creating intermediate trees as needed. The old tree is untouched.
 */
export function updateTreePath(repo: Repo, rootOid: string | null, parts: readonly string[], blobOid: string | null, mode = '100644'): string {
  if (parts.length === 0) throw new Error('updateTreePath needs a path');
  const name = parts[0] as string;
  const rest = parts.slice(1);
  const entries = rootOid === null ? [] : (getTree(repo, rootOid) ?? []);
  const next: TreeEntry[] = [];
  let handled = false;
  for (const entry of entries) {
    if (entry.name !== name) {
      next.push(entry);
      continue;
    }
    handled = true;
    if (rest.length === 0) {
      if (blobOid !== null) next.push({ mode, name, oid: blobOid });
      // blobOid null: drop the entry (delete).
    } else {
      if (entry.mode !== '40000') {
        // A file sits where a directory must go: replace it with the directory.
        if (blobOid === null && rest.length > 0) {
          // Deleting below a file: nothing to delete.
          next.push(entry);
        } else {
          const child = updateTreePath(repo, null, rest, blobOid, mode);
          next.push({ mode: '40000', name, oid: child });
        }
      } else {
        const child = updateTreePath(repo, entry.oid, rest, blobOid, mode);
        next.push({ mode: '40000', name, oid: child });
      }
    }
  }
  if (!handled) {
    if (rest.length === 0) {
      if (blobOid !== null) next.push({ mode, name, oid: blobOid });
    } else {
      if (blobOid !== null) {
        const child = updateTreePath(repo, null, rest, blobOid, mode);
        next.push({ mode: '40000', name, oid: child });
      }
    }
  }
  const built = buildTree(next);
  return putObject(repo, 'tree', built);
}

/** Create a commit on `branch` (or unborn) and move the ref to it. Returns the commit oid. */
export function commitOnBranch(
  store: Store,
  repo: Repo,
  branch: string,
  treeOid: string,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const id = store.identity();
  const author = `${id.name} <${id.email}> ${id.stamp}`;
  const commit: ParsedCommit = {
    tree: treeOid,
    parents: parent === undefined ? [] : [parent],
    author,
    committer: author,
    message,
  };
  const oid = putObject(repo, 'commit', buildCommit(commit));
  repo.refs.set(ref, oid);
  invalidateRepo(repo);
  return oid;
}

/** Drop every cache a mutation invalidates (packs, serialized JSON). Object caches never stale. */
export function invalidateRepo(repo: Repo): void {
  repo.packCache.clear();
  repo.issueJson.clear();
  repo.repoJson = null;
}

// ---------------------------------------------------------------------------
// diffs and merges
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** Line counts for a changed file, from a small LCS over its lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS lengths, two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const common = prev[m] as number;
  return { additions: m - common, deletions: n - common };
}

/** The files that differ between two trees (both may be null for an empty tree). */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map() : flattenTree(repo, headTree);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const counts = lineDiff(oldText, '');
      out.push({ path, status: 'removed', oldOid: b.oid, newOid: null, additions: 0, deletions: counts.deletions });
    } else if (b === undefined && h !== undefined) {
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const counts = lineDiff('', newText);
      out.push({ path, status: 'added', oldOid: null, newOid: h.oid, additions: counts.additions, deletions: 0 });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const counts = lineDiff(oldText, newText);
      out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, additions: counts.additions, deletions: counts.deletions });
    }
  }
  return out;
}

/** The current tips of a pull request's head and base branches. A pull request
 * records the shas its branches had when it was created; the branches move,
 * and the merge, conflict and files views all follow the current tips. */
function pullTips(repo: Repo, pull: Pull): { head: string; base: string } {
  return {
    head: repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha,
    base: repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha,
  };
}

/** The changed files of a pull request: merge-base tree vs head tree. */
export function pullRequestFiles(repo: Repo, pull: Pull): FileChange[] {
  const tips = pullTips(repo, pull);
  const headCommit = getCommit(repo, tips.head);
  const baseCommit = getCommit(repo, tips.base);
  if (headCommit === undefined || baseCommit === undefined) return [];
  const base = mergeBase(repo, tips.head, tips.base);
  const baseTree = base === null ? null : (getCommit(repo, base)?.tree ?? null);
  return diffTrees(repo, baseTree, headCommit.tree);
}

/** Whether a pull request can merge cleanly: no path changed on both sides to different bytes. */
export function pullRequestConflicts(repo: Repo, pull: Pull): string[] {
  const tips = pullTips(repo, pull);
  const headCommit = getCommit(repo, tips.head);
  const baseCommit = getCommit(repo, tips.base);
  if (headCommit === undefined || baseCommit === undefined) return [];
  const base = mergeBase(repo, tips.head, tips.base);
  if (base === null) return [];
  const baseTree = getCommit(repo, base)?.tree ?? null;
  const baseFlat = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, baseTree);
  const headFlat = flattenTree(repo, headCommit.tree);
  const tipFlat = flattenTree(repo, baseCommit.tree);
  const conflicts: string[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path)?.oid ?? null;
    const h = headFlat.get(path)?.oid ?? null;
    const t = tipFlat.get(path)?.oid ?? null;
    if (h !== b && t !== b && h !== t) conflicts.push(path);
  }
  return conflicts;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit oid. */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string {
  const tips = pullTips(repo, pull);
  const headCommit = getCommit(repo, tips.head) as ParsedCommit;
  const baseCommit = getCommit(repo, tips.base) as ParsedCommit;
  const base = mergeBase(repo, tips.head, tips.base);
  const baseTree = base === null ? null : (getCommit(repo, base)?.tree ?? null);
  const baseFlat = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, baseTree);
  const headFlat = flattenTree(repo, headCommit.tree);
  // Start from the base tip's tree and apply every head-side change since the merge-base.
  let treeOid: string | null = baseCommit.tree;
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFlat.get(path)?.oid ?? null;
    const h = headFlat.get(path)?.oid ?? null;
    if (h === b) continue;
    treeOid = updateTreePath(repo, treeOid, path.split('/'), h);
  }
  const id = store.identity();
  const author = `${id.name} <${id.email}> ${id.stamp}`;
  const message = `Merge pull request #${pull.number} from ${pull.head.ref}\n\n${pull.title}\n`;
  const commit: ParsedCommit = {
    tree: treeOid as string,
    parents: [tips.base],
    author,
    committer: author,
    message,
  };
  const oid = putObject(repo, 'commit', buildCommit(commit));
  repo.refs.set(`refs/heads/${pull.base.ref}`, oid);
  pull.head.sha = tips.head;
  pull.base.sha = oid;
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = store.iso(store.seq);
  pull.merge_commit_sha = oid;
  invalidateRepo(repo);
  return oid;
}

// ---------------------------------------------------------------------------
// global (Relay) ids
// ---------------------------------------------------------------------------

/** An opaque, stable global id for a repository, issue, pull request or comment. */
export function globalId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment', key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { kind: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.dbid));
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.dbid}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.dbid}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return globalId('IssueComment', `${repo.dbid}:${issue.number}:${comment.id}`);
}

export { buildTag, ZERO_OID };
