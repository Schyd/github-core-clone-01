// rest.ts — the GitHub REST v3 surface.
//
// Every route the suite drives, with the exact statuses and shapes its
// checks assert: repositories, branches, commits, contents, labels, issues,
// comments, pull requests, files and merges. Ownership is by the login the
// bearer token names (adaiversen); the same name under another owner is a
// 404, never a 403, and a request with no token is a 401.
//
// Responses are JSON everywhere, carry X-GitHub-Request-Id and
// X-OAuth-Scopes, and never HTML. Issue and repository bodies are cached as
// serialized strings and invalidated on mutation, so the timed read workload
// (2,000 sequential GETs of one issue) answers from a Map lookup.

import { getCommit, getObject, getTree, invalidateRepo, pullRequestConflicts, pullRequestFiles, resolveRef, squashMerge, updateTreePath, walkCommits, commitOnBranch, putObject, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, commentGlobalId, issueGlobalId, pullGlobalId, repoGlobalId, type Comment, type Issue, type Label, type Pull, type Repo, type Store } from './store.ts';
import { flattenTree as flattenTreeFromStore } from './store.ts';

export interface RestResult {
  status: number;
  /** Pre-serialized body (sent as-is). */
  text?: string;
  /** Object body (serialized by the caller). */
  json?: unknown;
  headers?: Record<string, string>;
}

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, each decodeURIComponent'd. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when there is none. */
  body: unknown;
  /** True when a body was present but did not parse as JSON. */
  bodyMalformed: boolean;
  /** The request's own origin (from the Host header), for Link headers. */
  origin: string;
  /** The bearer token, or null when absent. */
  token: string | null;
}

const NOT_FOUND: RestResult = { status: 404, json: { message: 'Not Found' } };
const UNAUTHORIZED: RestResult = { status: 401, json: { message: 'Requires authentication' } };
const BAD_JSON: RestResult = { status: 400, json: { message: 'Problems parsing JSON' } };

function err(status: number, message: string): RestResult {
  return { status, json: { message } };
}

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? VIEWER_ID : 2000, type: 'User' };
}

export function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbid,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: store.iso(repo.createdSeq),
    updated_at: store.iso(repo.createdSeq),
    pushed_at: store.iso(repo.createdSeq),
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
  };
}

/** The cached serialized repository object; recomputed after any mutation. */
export function repoJsonText(store: Store, repo: Repo): string {
  if (repo.repoJson === null) repo.repoJson = JSON.stringify(repoObject(store, repo));
  return repo.repoJson;
}

export function issueObject(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: userJson(issue.user),
    created_at: store.iso(issue.createdSeq),
    updated_at: store.iso(issue.updatedSeq),
    comments: issue.comments.length,
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** The cached serialized issue object; recomputed after any mutation. */
export function issueJsonText(store: Store, repo: Repo, issue: Issue): string {
  const cached = repo.issueJson.get(issue.number);
  if (cached !== undefined) return cached;
  const text = JSON.stringify(issueObject(store, repo, issue));
  repo.issueJson.set(issue.number, text);
  return text;
}

export function pullObject(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha, label: `${repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha, label: `${repo.owner}:${pull.base.ref}` },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    user: userJson(VIEWER_LOGIN),
    created_at: store.iso(pull.createdSeq),
    updated_at: store.iso(pull.createdSeq),
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentObject(store: Store, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, issue, comment),
    body: comment.body,
    user: userJson(comment.user),
    created_at: store.iso(comment.createdSeq),
    updated_at: store.iso(comment.createdSeq),
    html_url: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

function labelObject(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Math.min(100, Math.max(1, Number.isFinite(perPageRaw) ? perPageRaw : 30));
  return { page, perPage };
}

/** Slice `items` for the requested page and build the Link header (next/last). */
function paginate<T>(origin: string, path: string, query: URLSearchParams, items: readonly T[]): { slice: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const kept = new URLSearchParams(query);
  kept.set('per_page', String(perPage));
  const pageUrl = (pageNumber: number): string => {
    const params = new URLSearchParams(kept);
    params.set('page', String(pageNumber));
    return `${origin}${path}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${pageUrl(page + 1)}>; rel="next"`);
  if (totalPages > 1) links.push(`<${pageUrl(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${pageUrl(1)}>; rel="first"`, `<${pageUrl(page - 1)}>; rel="prev"`);
  return { slice, link: links.length > 0 ? links.join(', ') : null };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(body: unknown, field: string): string {
  if (!isRecord(body)) return '';
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

/** The repository for a /repos/{owner}/{name} route, or null when it is not the viewer's. */
function repoFor(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

/** The tip commit of a branch (creating the branch at the default tip when it is missing and the repo has one). */
function ensureBranch(store: Store, repo: Repo, branch: string): string | null {
  const ref = `refs/heads/${branch}`;
  const existing = repo.refs.get(ref);
  if (existing !== undefined) return existing;
  const base = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (base === undefined) return null;
  repo.refs.set(ref, base);
  invalidateRepo(repo);
  return base;
}

/** The tree oid at a branch tip (null when the branch has no commit yet). */
function branchTree(repo: Repo, branch: string): string | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return null;
  return getCommit(repo, tip)?.tree ?? null;
}

// ---------------------------------------------------------------------------
// repositories, branches, commits
// ---------------------------------------------------------------------------

function createRepoRoute(store: Store, req: RestRequest): RestResult {
  if (req.bodyMalformed) return BAD_JSON;
  const name = bodyString(req.body, 'name');
  if (name === '') return err(422, 'Validation Failed: name is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'Validation Failed: invalid repository name');
  const existing = store.getRepo(VIEWER_LOGIN, name);
  if (existing !== undefined) return err(422, 'Validation Failed: repository already exists');
  const description = bodyString(req.body, 'description');
  const isPrivate = isRecord(req.body) && req.body.private === true;
  const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
  return { status: 201, text: repoJsonText(store, repo) };
}

function listUserRepos(store: Store, req: RestRequest): RestResult {
  const repos = store.viewerRepos();
  const { slice, link } = paginate(req.origin, '/api/v3/user/repos', req.query, repos);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  return { status: 200, json: slice.map((repo) => repoObject(store, repo)), headers };
}

function getRepoRoute(store: Store, owner: string, name: string): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  return { status: 200, text: repoJsonText(store, repo) };
}

function patchRepoRoute(store: Store, req: RestRequest, owner: string, name: string): RestResult {
  if (req.bodyMalformed) return BAD_JSON;
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  if (isRecord(req.body) && typeof req.body.description === 'string') {
    repo.description = req.body.description;
    invalidateRepo(repo);
  }
  return { status: 200, text: repoJsonText(store, repo) };
}

function deleteRepoRoute(store: Store, owner: string, name: string): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  store.deleteRepo(owner, name);
  return { status: 204 };
}

function listBranches(store: Store, owner: string, name: string): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const branches: Record<string, unknown>[] = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort()) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
  }
  return { status: 200, json: branches };
}

function getBranch(store: Store, owner: string, name: string, branch: string): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return NOT_FOUND;
  return { status: 200, json: { name: branch, commit: { sha: oid } } };
}

function listCommits(store: Store, req: RestRequest, owner: string, name: string): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const sha = req.query.get('sha');
  const tip = sha === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : resolveRef(repo, sha);
  if (tip === undefined || tip === null) return { status: 200, json: [] };
  const oids = walkCommits(repo, tip);
  const out: Record<string, unknown>[] = [];
  for (const oid of oids) {
    const commit = getCommit(repo, oid);
    if (commit === undefined) continue;
    const author = parseIdentity(commit.author);
    const committer = parseIdentity(commit.committer);
    out.push({
      sha: oid,
      commit: {
        message: commit.message,
        author: { name: author.name, email: author.email, date: author.date },
        committer: { name: committer.name, email: committer.email, date: committer.date },
        tree: { sha: commit.tree },
      },
      author: { login: VIEWER_LOGIN },
      committer: { login: VIEWER_LOGIN },
    });
  }
  return { status: 200, json: out };
}

function createRef(store: Store, req: RestRequest, owner: string, name: string): RestResult {
  if (req.bodyMalformed) return BAD_JSON;
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const ref = bodyString(req.body, 'ref');
  const sha = bodyString(req.body, 'sha');
  if (ref === '' || sha === '') return err(422, 'Validation Failed: ref and sha are required');
  if (!ref.startsWith('refs/')) return err(422, 'Validation Failed: ref must start with refs/');
  if (repo.refs.has(ref)) return err(422, 'Validation Failed: ref already exists');
  const object = getObject(repo, sha);
  if (object === undefined) return err(422, 'Validation Failed: sha does not exist');
  repo.refs.set(ref, sha);
  invalidateRepo(repo);
  return { status: 201, json: { ref, object: { sha, type: object.type } } };
}

function getRef(store: Store, owner: string, name: string, refPath: string): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const oid = repo.refs.get(refPath);
  if (oid === undefined) return NOT_FOUND;
  const object = getObject(repo, oid);
  return { status: 200, json: { ref: refPath, object: { sha: oid, type: object?.type ?? 'commit' } } };
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function putContents(store: Store, req: RestRequest, owner: string, name: string, path: string): RestResult {
  if (req.bodyMalformed) return BAD_JSON;
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const message = bodyString(req.body, 'message');
  const contentB64 = bodyString(req.body, 'content');
  const branch = bodyString(req.body, 'branch') || repo.defaultBranch;
  const sha = bodyString(req.body, 'sha');
  if (contentB64 === '') return err(422, 'Validation Failed: content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return err(422, 'Validation Failed: content is not valid base64');
  }
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length === 0) return err(422, 'Validation Failed: path is required');
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined) {
    // A write to a branch that does not exist yet forks it from the default tip.
    const created = ensureBranch(store, repo, branch);
    if (created === null && repo.refs.size > 0) return err(422, 'Validation Failed: branch does not exist');
    tip = repo.refs.get(ref);
  }
  const currentTree = tip === undefined ? null : (getCommit(repo, tip)?.tree ?? null);
  const flat = currentTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTreeFromStore(repo, currentTree);
  const existing = flat.get(path);
  if (sha !== '') {
    if (existing === undefined || existing.oid !== sha) return err(409, 'sha does not match the current blob');
  }
  const blobOid = putObject(repo, 'blob', content);
  const newTree = updateTreePath(repo, currentTree, parts, blobOid);
  const isUpdate = existing !== undefined;
  const commitSha = commitOnBranch(store, repo, branch, newTree, message === '' ? `Update ${path}` : message);
  return {
    status: isUpdate ? 200 : 201,
    json: {
      content: { name: parts[parts.length - 1], path, sha: blobOid, size: content.length, encoding: 'base64' },
      commit: { sha: commitSha },
    },
  };
}

function getContents(store: Store, req: RestRequest, owner: string, name: string, path: string): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const refParam = req.query.get('ref');
  const tip = refParam === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : resolveRef(repo, refParam);
  if (tip === undefined || tip === null) return NOT_FOUND;
  const treeOid = getCommit(repo, tip)?.tree;
  if (treeOid === undefined) return NOT_FOUND;
  const flat = flattenTreeFromStore(repo, treeOid);
  const entry = flat.get(path);
  if (entry !== undefined) {
    const object = getObject(repo, entry.oid);
    if (object === undefined) return NOT_FOUND;
    return {
      status: 200,
      json: {
        type: 'file',
        encoding: 'base64',
        content: object.data.toString('base64'),
        sha: entry.oid,
        size: object.data.length,
        name: path.split('/').pop(),
        path,
      },
    };
  }
  // A directory: descend to the tree node at `path` and list its direct children.
  let current = treeOid;
  if (path !== '') {
    for (const part of path.split('/')) {
      const entries = getTree(repo, current);
      const child = entries?.find((entry) => entry.name === part && entry.mode === '40000');
      if (child === undefined) return NOT_FOUND;
      current = child.oid;
    }
  }
  const dirEntries = getTree(repo, current);
  if (dirEntries === undefined) return NOT_FOUND;
  const children = dirEntries.map((entry) => ({
    type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.oid,
  }));
  if (children.length === 0) return NOT_FOUND;
  return { status: 200, json: children.sort((a, b) => (a.name < b.name ? -1 : 1)) };
}

function deleteContents(store: Store, req: RestRequest, owner: string, name: string, path: string): RestResult {
  if (req.bodyMalformed) return BAD_JSON;
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const message = bodyString(req.body, 'message');
  const sha = bodyString(req.body, 'sha');
  const branch = bodyString(req.body, 'branch') || repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return NOT_FOUND;
  const treeOid = getCommit(repo, tip)?.tree;
  if (treeOid === undefined) return NOT_FOUND;
  const flat = flattenTreeFromStore(repo, treeOid);
  const entry = flat.get(path);
  if (entry === undefined) return NOT_FOUND;
  if (sha !== '' && entry.oid !== sha) return err(409, 'sha does not match the current blob');
  const parts = path.split('/').filter((part) => part !== '');
  const newTree = updateTreePath(repo, treeOid, parts, null);
  const commitSha = commitOnBranch(store, repo, branch, newTree, message === '' ? `Delete ${path}` : message);
  return { status: 200, json: { commit: { sha: commitSha } } };
}

// ---------------------------------------------------------------------------
// labels, issues, comments
// ---------------------------------------------------------------------------

function createLabel(store: Store, req: RestRequest, owner: string, name: string): RestResult {
  if (req.bodyMalformed) return BAD_JSON;
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const labelName = bodyString(req.body, 'name');
  if (labelName === '') return err(422, 'Validation Failed: name is required');
  const color = bodyString(req.body, 'color') || 'ededed';
  const existing = repo.labels.get(labelName);
  if (existing !== undefined) return { status: 201, json: labelObject(existing) };
  const label: Label = { name: labelName, color };
  repo.labels.set(labelName, label);
  return { status: 201, json: labelObject(label) };
}

function listLabels(store: Store, owner: string, name: string): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  return { status: 200, json: [...repo.labels.values()].map(labelObject) };
}

function createIssueRoute(store: Store, req: RestRequest, owner: string, name: string): RestResult {
  if (req.bodyMalformed) return BAD_JSON;
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const title = bodyString(req.body, 'title');
  if (title === '') return err(422, 'Validation Failed: title is required');
  const body = bodyString(req.body, 'body');
  const labels: Label[] = [];
  if (isRecord(req.body) && Array.isArray(req.body.labels)) {
    for (const entry of req.body.labels) {
      if (typeof entry !== 'string') continue;
      const label = repo.labels.get(entry);
      if (label === undefined) return err(422, `Validation Failed: label ${JSON.stringify(entry)} does not exist`);
      labels.push(label);
    }
  }
  const seq = store.tick();
  const issue: Issue = {
    id: store.nextIssueId++,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels,
    user: VIEWER_LOGIN,
    createdSeq: seq,
    updatedSeq: seq,
    comments: [],
  };
  repo.issues.push(issue);
  invalidateRepo(repo);
  return { status: 201, text: issueJsonText(store, repo, issue) };
}

function listIssuesRoute(store: Store, req: RestRequest, owner: string, name: string): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const state = req.query.get('state') ?? 'open';
  const sort = req.query.get('sort') ?? 'created';
  const direction = req.query.get('direction') ?? 'desc';
  let issues = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
  if (sort === 'created') {
    issues = [...issues].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  }
  const { slice, link } = paginate(req.origin, `/api/v3/repos/${owner}/${name}/issues`, req.query, issues);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  return { status: 200, json: slice.map((issue) => JSON.parse(issueJsonText(store, repo, issue))), headers };
}

function getIssueRoute(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return NOT_FOUND;
  return { status: 200, text: issueJsonText(store, repo, issue) };
}

function patchIssueRoute(store: Store, req: RestRequest, owner: string, name: string, number: number): RestResult {
  if (req.bodyMalformed) return BAD_JSON;
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return NOT_FOUND;
  if (isRecord(req.body)) {
    if (req.body.state === 'open' || req.body.state === 'closed') issue.state = req.body.state;
    if (typeof req.body.title === 'string') issue.title = req.body.title;
    if (typeof req.body.body === 'string') issue.body = req.body.body;
    issue.updatedSeq = store.tick();
  }
  invalidateRepo(repo);
  return { status: 200, text: issueJsonText(store, repo, issue) };
}

function createCommentRoute(store: Store, req: RestRequest, owner: string, name: string, number: number): RestResult {
  if (req.bodyMalformed) return BAD_JSON;
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return NOT_FOUND;
  const body = bodyString(req.body, 'body');
  if (body === '') return err(422, 'Validation Failed: body is required');
  const comment: Comment = { id: repo.nextCommentId++, body, user: VIEWER_LOGIN, createdSeq: store.tick() };
  issue.comments.push(comment);
  invalidateRepo(repo);
  return { status: 201, json: commentObject(store, repo, issue, comment) };
}

function listCommentsRoute(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return NOT_FOUND;
  return { status: 200, json: issue.comments.map((comment) => commentObject(store, repo, issue, comment)) };
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

function createPullRoute(store: Store, req: RestRequest, owner: string, name: string): RestResult {
  if (req.bodyMalformed) return BAD_JSON;
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const title = bodyString(req.body, 'title');
  const head = bodyString(req.body, 'head');
  const base = bodyString(req.body, 'base');
  if (title === '' || head === '' || base === '') return err(422, 'Validation Failed: title, head and base are required');
  const headSha = resolveRef(repo, head);
  const baseSha = resolveRef(repo, base);
  if (headSha === null || baseSha === null) return err(422, 'Validation Failed: head or base branch does not exist');
  const body = bodyString(req.body, 'body');
  const seq = store.tick();
  const pull: Pull = {
    id: store.nextPullId++,
    number: repo.nextPull++,
    title,
    body,
    state: 'open',
    head: { ref: head, sha: headSha },
    base: { ref: base, sha: baseSha },
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    createdSeq: seq,
  };
  repo.pulls.push(pull);
  invalidateRepo(repo);
  return { status: 201, json: pullObject(store, repo, pull) };
}

function listPullsRoute(store: Store, req: RestRequest, owner: string, name: string): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const state = req.query.get('state') ?? 'open';
  const pulls = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state));
  const { slice, link } = paginate(req.origin, `/api/v3/repos/${owner}/${name}/pulls`, req.query, pulls);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  return { status: 200, json: slice.map((pull) => pullObject(store, repo, pull)), headers };
}

function getPullRoute(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return NOT_FOUND;
  return { status: 200, json: pullObject(store, repo, pull) };
}

function listPullFilesRoute(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return NOT_FOUND;
  const files = pullRequestFiles(repo, pull).map((change) => ({
    filename: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
  }));
  return { status: 200, json: files };
}

function mergePullRoute(store: Store, req: RestRequest, owner: string, name: string, number: number): RestResult {
  if (req.bodyMalformed) return BAD_JSON;
  const repo = repoFor(store, owner, name);
  if (repo === null) return NOT_FOUND;
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return NOT_FOUND;
  if (pull.state !== 'open') return err(405, 'Pull request is already closed');
  const conflicts = pullRequestConflicts(repo, pull);
  if (conflicts.length > 0) return err(405, 'Merge conflict');
  const sha = squashMerge(store, repo, pull);
  return { status: 200, json: { sha, merged: true, message: 'Pull request successfully merged' } };
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

/** Handle one /api/v3 request. Auth is required for every route here. */
export function handleRest(store: Store, req: RestRequest): RestResult {
  if (req.token === null || req.token === '') return UNAUTHORIZED;
  const s = req.segments;
  const method = req.method;

  if (method === 'GET' && s.length === 0) {
    return { status: 200, json: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, headers: { 'x-oauth-scopes': 'repo, read:org' } };
  }
  if (method === 'GET' && s.length === 1 && s[0] === 'meta') {
    return { status: 200, json: { installed_version: '1.0.0' } };
  }
  if (method === 'GET' && s.length === 1 && s[0] === 'user') {
    return { status: 200, json: { login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: VIEWER_EMAIL, type: 'User' } };
  }
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') return listUserRepos(store, req);
    if (method === 'POST') return createRepoRoute(store, req);
    return NOT_FOUND;
  }
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1] as string;
    const name = s[2] as string;
    const rest = s.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') return getRepoRoute(store, owner, name);
      if (method === 'PATCH') return patchRepoRoute(store, req, owner, name);
      if (method === 'DELETE') return deleteRepoRoute(store, owner, name);
      return NOT_FOUND;
    }
    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') return listBranches(store, owner, name);
    if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') return getBranch(store, owner, name, rest[1] as string);
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') return listCommits(store, req, owner, name);
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') return createRef(store, req, owner, name);
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length > 3 && method === 'GET') {
      return getRef(store, owner, name, rest.slice(2).join('/'));
    }
    if (rest[0] === 'contents' && rest.length >= 2) {
      const path = rest.slice(1).join('/');
      if (method === 'PUT') return putContents(store, req, owner, name, path);
      if (method === 'GET') return getContents(store, req, owner, name, path);
      if (method === 'DELETE') return deleteContents(store, req, owner, name, path);
      return NOT_FOUND;
    }
    if (rest[0] === 'contents' && rest.length === 1 && method === 'GET') {
      return getContents(store, req, owner, name, '');
    }
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'POST') return createLabel(store, req, owner, name);
      if (method === 'GET') return listLabels(store, owner, name);
      return NOT_FOUND;
    }
    if (rest[0] === 'issues' && rest.length === 1) {
      if (method === 'POST') return createIssueRoute(store, req, owner, name);
      if (method === 'GET') return listIssuesRoute(store, req, owner, name);
      return NOT_FOUND;
    }
    if (rest[0] === 'issues' && rest.length === 2) {
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) return NOT_FOUND;
      if (method === 'GET') return getIssueRoute(store, owner, name, number);
      if (method === 'PATCH') return patchIssueRoute(store, req, owner, name, number);
      return NOT_FOUND;
    }
    if (rest[0] === 'issues' && rest.length === 3 && rest[2] === 'comments') {
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) return NOT_FOUND;
      if (method === 'POST') return createCommentRoute(store, req, owner, name, number);
      if (method === 'GET') return listCommentsRoute(store, owner, name, number);
      return NOT_FOUND;
    }
    if (rest[0] === 'pulls' && rest.length === 1) {
      if (method === 'POST') return createPullRoute(store, req, owner, name);
      if (method === 'GET') return listPullsRoute(store, req, owner, name);
      return NOT_FOUND;
    }
    if (rest[0] === 'pulls' && rest.length === 2) {
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) return NOT_FOUND;
      if (method === 'GET') return getPullRoute(store, owner, name, number);
      return NOT_FOUND;
    }
    if (rest[0] === 'pulls' && rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) return NOT_FOUND;
      return listPullFilesRoute(store, owner, name, number);
    }
    if (rest[0] === 'pulls' && rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) return NOT_FOUND;
      return mergePullRoute(store, req, owner, name, number);
    }
    return NOT_FOUND;
  }
  return NOT_FOUND;
}
