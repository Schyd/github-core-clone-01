// mcp.ts — the Model Context Protocol endpoint (POST /mcp).
//
// JSON-RPC 2.0 over Streamable HTTP, plain-JSON replies. Two protocol eras:
// the modern 2026-07-28 era (server/discover, no handshake, no session) and
// the legacy era (initialize + notifications/initialized). Exactly six tools,
// all acting on the same store as REST and GraphQL, so a repository created
// through MCP reads back identically through REST.
//
// The tools/list answer is built once and reused verbatim, so two calls are
// byte-identical. Unknown tools and missing arguments are JSON-RPC errors or
// isError results, never an HTTP 500.

import { invalidateRepo, pullRequestConflicts, resolveRef, squashMerge, VIEWER_LOGIN, type Issue, type Pull, type Store } from './store.ts';
import { issueObject, pullObject, repoObject } from './rest.ts';

export interface McpResult {
  status: number;
  /** JSON body, or null for an empty (202 notification) reply. */
  json: unknown;
}

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'The state of the issues to list: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch of the pull request.' },
        base: { type: 'string', description: 'The base branch of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function toolTextResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argString(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' ? value : null;
}

function missingArg(args: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

function repoForTool(store: Store, args: Record<string, unknown>): { repo: NonNullable<ReturnType<Store['getRepo']>> } | { error: string } {
  const owner = argString(args, 'owner');
  const name = argString(args, 'repo');
  if (owner === null || name === null) return { error: 'Missing required argument: owner and repo are required' };
  if (owner !== VIEWER_LOGIN) return { error: 'Not Found' };
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return { error: 'Not Found' };
  return { repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const missing = missingArg(args, ['name']);
      if (missing !== null) return toolErrorResult(`Missing required argument: ${missing}`);
      const repoName = argString(args, 'name') as string;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) {
        return toolErrorResult('Invalid repository name');
      }
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        return toolErrorResult('Validation Failed: repository already exists');
      }
      const description = argString(args, 'description') ?? '';
      const isPrivate = args.private === true;
      const repo = store.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
      return toolTextResult(repoObject(store, repo));
    }
    case 'get_repo': {
      const found = repoForTool(store, args);
      if ('error' in found) return toolErrorResult(found.error);
      return toolTextResult(repoObject(store, found.repo));
    }
    case 'create_issue': {
      const missing = missingArg(args, ['owner', 'repo', 'title']);
      if (missing !== null) return toolErrorResult(`Missing required argument: ${missing}`);
      const found = repoForTool(store, args);
      if ('error' in found) return toolErrorResult(found.error);
      const repo = found.repo;
      const title = argString(args, 'title') as string;
      const body = argString(args, 'body') ?? '';
      const seq = store.tick();
      const issue: Issue = {
        id: store.nextIssueId++,
        number: repo.nextIssue++,
        title,
        body,
        state: 'open',
        labels: [],
        user: VIEWER_LOGIN,
        createdSeq: seq,
        updatedSeq: seq,
        comments: [],
      };
      repo.issues.push(issue);
      invalidateRepo(repo);
      return toolTextResult(issueObject(store, repo, issue));
    }
    case 'list_issues': {
      const missing = missingArg(args, ['owner', 'repo']);
      if (missing !== null) return toolErrorResult(`Missing required argument: ${missing}`);
      const found = repoForTool(store, args);
      if ('error' in found) return toolErrorResult(found.error);
      const repo = found.repo;
      const state = argString(args, 'state') ?? 'open';
      const issues = repo.issues
        .filter((issue) => (state === 'all' ? true : issue.state === state))
        .map((issue) => issueObject(store, repo, issue));
      return toolTextResult(issues);
    }
    case 'create_pull_request': {
      const missing = missingArg(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing !== null) return toolErrorResult(`Missing required argument: ${missing}`);
      const found = repoForTool(store, args);
      if ('error' in found) return toolErrorResult(found.error);
      const repo = found.repo;
      const head = resolveRef(repo, argString(args, 'head') as string);
      const base = resolveRef(repo, argString(args, 'base') as string);
      if (head === null || base === null) return toolErrorResult('Head or base branch does not exist');
      const pull: Pull = {
        id: store.nextPullId++,
        number: repo.nextPull++,
        title: argString(args, 'title') as string,
        body: '',
        state: 'open',
        head: { ref: argString(args, 'head') as string, sha: head },
        base: { ref: argString(args, 'base') as string, sha: base },
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        createdSeq: store.tick(),
      };
      repo.pulls.push(pull);
      invalidateRepo(repo);
      return toolTextResult(pullObject(store, repo, pull));
    }
    case 'merge_pull_request': {
      const missing = missingArg(args, ['owner', 'repo', 'pull_number']);
      if (missing !== null) return toolErrorResult(`Missing required argument: ${missing}`);
      const found = repoForTool(store, args);
      if ('error' in found) return toolErrorResult(found.error);
      const repo = found.repo;
      const raw = args.pull_number;
      const number = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return toolErrorResult('Not Found');
      if (pull.state !== 'open') return toolErrorResult('Pull request is already closed');
      if (pullRequestConflicts(repo, pull).length > 0) return toolErrorResult('Merge conflict');
      squashMerge(store, repo, pull);
      return toolTextResult(pullObject(store, repo, pull));
    }
    default:
      return toolErrorResult(`Unknown tool: ${name}`);
  }
}

/** Handle one POST /mcp request. `bodyText` is the raw request body. */
export function handleMcp(store: Store, bodyText: string, token: string | null): McpResult {
  if (token === null || token === '') {
    return { status: 401, json: { message: 'Requires authentication' } };
  }
  let request: unknown;
  try {
    request = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (!isRecord(request) || typeof request.method !== 'string') {
    return { status: 400, json: rpcError(null, -32600, 'Invalid Request') };
  }
  const id = request.id;
  const isNotification = id === undefined;
  if (isNotification) {
    // Notifications (e.g. notifications/initialized) get an empty 202.
    return { status: 202, json: null };
  }
  const method = request.method;
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return {
      status: 200,
      json: rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      }),
    };
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const protocolVersion = offered !== null && SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return {
      status: 200,
      json: rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method === 'tools/list') {
    return { status: 200, json: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (!TOOLS.some((tool) => tool.name === toolName)) {
      return { status: 200, json: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
    }
    const result = callTool(store, toolName, args);
    return { status: 200, json: rpcResult(id, result) };
  }
  if (method === 'ping') {
    return { status: 200, json: rpcResult(id, {}) };
  }
  return { status: 200, json: rpcError(id, -32601, `Method not found: ${method}`) };
}
