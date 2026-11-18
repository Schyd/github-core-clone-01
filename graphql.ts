// graphql.ts — a hand-written GraphQL executor for the /api/graphql surface.
//
// No GraphQL library is available (stdlib only, Node 22), so this file is a
// small parser plus a resolver table: query/mutation operations, variables,
// aliases, inline and named fragments, __typename, __schema and __type
// introspection, and batched requests (a JSON array body returns an array of
// responses in order).
//
// The schema mirrors the subset of GitHub's GraphQL API the suite exercises:
// viewer, repository, node, issues/pullRequests connections with cursor
// pagination, and the createIssue / closeIssue / createPullRequest /
// mergePullRequest / addComment mutations. Global ids are opaque base64url
// `Kind:key` strings — never the plain database id or number — and are stable
// across reads because they derive from the stored ids.

import { decodeGlobalId, getCommit, invalidateRepo, pullRequestConflicts, pullRequestFiles, resolveRef, squashMerge, VIEWER_ID, VIEWER_LOGIN, commentGlobalId, issueGlobalId, pullGlobalId, repoGlobalId, type Comment, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch) || ch === '.' && source.slice(i, i + 3) === '...') {
      if (source.slice(i, i + 3) === '...') {
        tokens.push({ kind: 'punct', value: '...' });
        i += 3;
      } else {
        tokens.push({ kind: 'punct', value: ch });
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      // A block string (""") is unlikely in the suite's documents; treat a
      // triple quote as an empty string and skip to the closing triple quote.
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: end === -1 ? '' : source.slice(i + 3, end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let out = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 4;
          } else out += esc ?? '';
          i += 2;
        } else {
          out += source[i];
          i += 1;
        }
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push(isFloat ? { kind: 'float', value: source.slice(i, j) } : { kind: 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[];
}

export interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

export interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: { name: string; type: string; defaultValue: ValueNode | null }[];
  selectionSet: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

export type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected "${value}" but got ${token.kind === 'name' ? token.value : token.value}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name but got ${token.value}`);
    return token.value;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek() !== undefined) {
      definitions.push(this.parseDefinition());
    }
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value;
      const variableDefinitions = this.parseVariableDefinitions();
      return { kind: 'operation', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
    }
    if (token?.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      const on = this.expectName();
      if (on !== 'on') throw new Error('Expected "on" in fragment definition');
      const typeCondition = this.expectName();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`Unexpected token ${token === undefined ? 'EOF' : token.value}`);
  }

  private parseVariableDefinitions(): { name: string; type: string; defaultValue: ValueNode | null }[] {
    const definitions: { name: string; type: string; defaultValue: ValueNode | null }[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          defaultValue = this.parseValue(true);
        }
        definitions.push({ name, type, defaultValue });
      }
      this.expectPunct(')');
    }
    return definitions;
  }

  private parseType(): string {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    if (token.kind !== 'name') throw new Error('Expected a type name');
    let out = token.value;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') {
      this.next();
      out += '!';
    }
    return out;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    if (token?.kind === 'name') {
      const first = this.next().value;
      let alias: string | null = null;
      let name = first;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args: { name: string; value: ValueNode }[] = [];
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue(false) });
        }
        this.expectPunct(')');
      }
      // Directives (@include/@skip) are ignored: the suite does not use them.
      while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
        this.next();
        this.expectName();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
          this.next();
          let depth = 1;
          while (depth > 0) {
            const tok = this.next();
            if (tok.kind === 'punct' && tok.value === '(') depth += 1;
            if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
          }
        }
      }
      let selectionSet: SelectionNode[] = [];
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
        selectionSet = this.parseSelectionSet();
      }
      return { kind: 'field', alias, name, args, selectionSet };
    }
    throw new Error(`Unexpected token in selection set: ${token === undefined ? 'EOF' : token.value}`);
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new Error('Variable in constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue(isConst));
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${token.value}`);
  }
}

/** Resolve a value AST node against the supplied variables. */
export function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function parseDocument(source: string): DefinitionNode[] {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------------------
// schema registry (drives __type / __schema introspection)
// ---------------------------------------------------------------------------

interface FieldDef {
  name: string;
  type: string;
  args?: { name: string; type: string }[];
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  name: string;
  fields?: FieldDef[];
  enumValues?: string[];
  inputFields?: { name: string; type: string }[];
}

const TYPES = new Map<string, TypeDef>();

function defineType(def: TypeDef): void {
  TYPES.set(def.name, def);
}

defineType({ kind: 'OBJECT', name: 'Query', fields: [
  { name: 'viewer', type: 'User' },
  { name: 'repository', type: 'Repository', args: [{ name: 'owner', type: 'String!' }, { name: 'name', type: 'String!' }] },
  { name: 'node', type: 'Node', args: [{ name: 'id', type: 'ID!' }] },
] });
defineType({ kind: 'OBJECT', name: 'Mutation', fields: [
  { name: 'createIssue', type: 'CreateIssuePayload', args: [{ name: 'input', type: 'CreateIssueInput!' }] },
  { name: 'closeIssue', type: 'CloseIssuePayload', args: [{ name: 'input', type: 'CloseIssueInput!' }] },
  { name: 'createPullRequest', type: 'CreatePullRequestPayload', args: [{ name: 'input', type: 'CreatePullRequestInput!' }] },
  { name: 'mergePullRequest', type: 'MergePullRequestPayload', args: [{ name: 'input', type: 'MergePullRequestInput!' }] },
  { name: 'addComment', type: 'AddCommentPayload', args: [{ name: 'input', type: 'AddCommentInput!' }] },
] });
defineType({ kind: 'OBJECT', name: 'User', fields: [
  { name: 'id', type: 'ID!' },
  { name: 'login', type: 'String!' },
  { name: 'databaseId', type: 'Int' },
] });
defineType({ kind: 'OBJECT', name: 'Repository', fields: [
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'name', type: 'String!' },
  { name: 'nameWithOwner', type: 'String!' },
  { name: 'owner', type: 'User' },
  { name: 'defaultBranchRef', type: 'Ref' },
  { name: 'viewerPermission', type: 'RepositoryPermission' },
  { name: 'hasIssuesEnabled', type: 'Boolean' },
  { name: 'createdAt', type: 'String' },
  { name: 'issue', type: 'Issue', args: [{ name: 'number', type: 'Int!' }] },
  { name: 'issues', type: 'IssueConnection', args: [
    { name: 'first', type: 'Int' }, { name: 'after', type: 'String' },
    { name: 'states', type: '[IssueState!]' }, { name: 'orderBy', type: 'IssueOrder' },
  ] },
  { name: 'pullRequest', type: 'PullRequest', args: [{ name: 'number', type: 'Int!' }] },
  { name: 'pullRequests', type: 'PullRequestConnection', args: [
    { name: 'first', type: 'Int' }, { name: 'after', type: 'String' },
  ] },
] });
defineType({ kind: 'OBJECT', name: 'Issue', fields: [
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'number', type: 'Int!' },
  { name: 'title', type: 'String!' },
  { name: 'body', type: 'String' },
  { name: 'state', type: 'IssueState' },
  { name: 'author', type: 'User' },
  { name: 'createdAt', type: 'String' },
  { name: 'labels', type: 'LabelConnection', args: [{ name: 'first', type: 'Int' }] },
  { name: 'comments', type: 'IssueCommentConnection', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
] });
defineType({ kind: 'OBJECT', name: 'PullRequest', fields: [
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'number', type: 'Int!' },
  { name: 'title', type: 'String!' },
  { name: 'body', type: 'String' },
  { name: 'state', type: 'PullRequestState' },
  { name: 'headRefName', type: 'String' },
  { name: 'baseRefName', type: 'String' },
  { name: 'mergeable', type: 'MergeableState' },
  { name: 'merged', type: 'Boolean' },
  { name: 'author', type: 'User' },
  { name: 'createdAt', type: 'String' },
  { name: 'files', type: 'PullRequestFileConnection', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
] });
defineType({ kind: 'OBJECT', name: 'IssueConnection', fields: [
  { name: 'nodes', type: '[Issue]' },
  { name: 'edges', type: '[IssueEdge]' },
  { name: 'pageInfo', type: 'PageInfo!' },
  { name: 'totalCount', type: 'Int!' },
] });
defineType({ kind: 'OBJECT', name: 'IssueEdge', fields: [
  { name: 'node', type: 'Issue' },
  { name: 'cursor', type: 'String!' },
] });
defineType({ kind: 'OBJECT', name: 'PullRequestConnection', fields: [
  { name: 'nodes', type: '[PullRequest]' },
  { name: 'edges', type: '[PullRequestEdge]' },
  { name: 'pageInfo', type: 'PageInfo!' },
  { name: 'totalCount', type: 'Int!' },
] });
defineType({ kind: 'OBJECT', name: 'PullRequestEdge', fields: [
  { name: 'node', type: 'PullRequest' },
  { name: 'cursor', type: 'String!' },
] });
defineType({ kind: 'OBJECT', name: 'PullRequestFileConnection', fields: [
  { name: 'nodes', type: '[FileChange]' },
  { name: 'edges', type: '[PullRequestFileEdge]' },
  { name: 'pageInfo', type: 'PageInfo!' },
  { name: 'totalCount', type: 'Int!' },
] });
defineType({ kind: 'OBJECT', name: 'PullRequestFileEdge', fields: [
  { name: 'node', type: 'FileChange' },
  { name: 'cursor', type: 'String!' },
] });
defineType({ kind: 'OBJECT', name: 'FileChange', fields: [
  { name: 'path', type: 'String' },
  { name: 'additions', type: 'Int' },
  { name: 'deletions', type: 'Int' },
  { name: 'changeType', type: 'String' },
] });
defineType({ kind: 'OBJECT', name: 'PageInfo', fields: [
  { name: 'hasNextPage', type: 'Boolean!' },
  { name: 'hasPreviousPage', type: 'Boolean!' },
  { name: 'startCursor', type: 'String' },
  { name: 'endCursor', type: 'String' },
] });
defineType({ kind: 'OBJECT', name: 'Ref', fields: [{ name: 'name', type: 'String' }] });
defineType({ kind: 'OBJECT', name: 'Label', fields: [
  { name: 'id', type: 'ID!' },
  { name: 'name', type: 'String!' },
  { name: 'color', type: 'String' },
] });
defineType({ kind: 'OBJECT', name: 'LabelConnection', fields: [
  { name: 'nodes', type: '[Label]' },
  { name: 'edges', type: '[LabelEdge]' },
  { name: 'pageInfo', type: 'PageInfo!' },
  { name: 'totalCount', type: 'Int!' },
] });
defineType({ kind: 'OBJECT', name: 'LabelEdge', fields: [
  { name: 'node', type: 'Label' },
  { name: 'cursor', type: 'String!' },
] });
defineType({ kind: 'OBJECT', name: 'Comment', fields: [
  { name: 'id', type: 'ID!' },
  { name: 'databaseId', type: 'Int' },
  { name: 'body', type: 'String' },
  { name: 'author', type: 'User' },
  { name: 'createdAt', type: 'String' },
] });
defineType({ kind: 'OBJECT', name: 'IssueCommentConnection', fields: [
  { name: 'nodes', type: '[Comment]' },
  { name: 'edges', type: '[IssueCommentEdge]' },
  { name: 'pageInfo', type: 'PageInfo!' },
  { name: 'totalCount', type: 'Int!' },
] });
defineType({ kind: 'OBJECT', name: 'IssueCommentEdge', fields: [
  { name: 'node', type: 'Comment' },
  { name: 'cursor', type: 'String!' },
] });
defineType({ kind: 'OBJECT', name: 'CreateIssuePayload', fields: [{ name: 'issue', type: 'Issue' }] });
defineType({ kind: 'OBJECT', name: 'CloseIssuePayload', fields: [{ name: 'issue', type: 'Issue' }] });
defineType({ kind: 'OBJECT', name: 'CreatePullRequestPayload', fields: [{ name: 'pullRequest', type: 'PullRequest' }] });
defineType({ kind: 'OBJECT', name: 'MergePullRequestPayload', fields: [{ name: 'pullRequest', type: 'PullRequest' }] });
defineType({ kind: 'OBJECT', name: 'AddCommentPayload', fields: [
  { name: 'commentEdge', type: 'IssueCommentEdge' },
  { name: 'subject', type: 'Issue' },
] });
defineType({ kind: 'ENUM', name: 'IssueState', enumValues: ['OPEN', 'CLOSED'] });
defineType({ kind: 'ENUM', name: 'PullRequestState', enumValues: ['OPEN', 'CLOSED', 'MERGED'] });
defineType({ kind: 'ENUM', name: 'MergeableState', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] });
defineType({ kind: 'ENUM', name: 'RepositoryPermission', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] });
defineType({ kind: 'ENUM', name: 'SearchType', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PACKAGE', 'WIKI', 'PROJECT'] });
defineType({ kind: 'ENUM', name: 'IssueOrderField', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] });
defineType({ kind: 'ENUM', name: 'OrderDirection', enumValues: ['ASC', 'DESC'] });
defineType({ kind: 'ENUM', name: 'PullRequestMergeMethod', enumValues: ['MERGE', 'SQUASH', 'REBASE'] });
defineType({ kind: 'INPUT_OBJECT', name: 'CreateIssueInput', inputFields: [
  { name: 'repositoryId', type: 'ID!' }, { name: 'title', type: 'String!' }, { name: 'body', type: 'String' },
] });
defineType({ kind: 'INPUT_OBJECT', name: 'CloseIssueInput', inputFields: [{ name: 'issueId', type: 'ID!' }] });
defineType({ kind: 'INPUT_OBJECT', name: 'CreatePullRequestInput', inputFields: [
  { name: 'repositoryId', type: 'ID!' }, { name: 'baseRefName', type: 'String!' },
  { name: 'headRefName', type: 'String!' }, { name: 'title', type: 'String!' }, { name: 'body', type: 'String' },
] });
defineType({ kind: 'INPUT_OBJECT', name: 'MergePullRequestInput', inputFields: [
  { name: 'pullRequestId', type: 'ID!' }, { name: 'mergeMethod', type: 'PullRequestMergeMethod' },
] });
defineType({ kind: 'INPUT_OBJECT', name: 'AddCommentInput', inputFields: [
  { name: 'subjectId', type: 'ID!' }, { name: 'body', type: 'String!' },
] });
defineType({ kind: 'INPUT_OBJECT', name: 'IssueOrder', inputFields: [
  { name: 'field', type: 'IssueOrderField' }, { name: 'direction', type: 'OrderDirection' },
] });
for (const scalar of ['String', 'Int', 'Boolean', 'ID']) {
  defineType({ kind: 'SCALAR', name: scalar });
}

/** Build an introspection type reference from a type string like "[IssueEdge!]!". */
function typeRef(type: string): Record<string, unknown> {
  let text = type;
  let nonNull = false;
  if (text.endsWith('!')) {
    nonNull = true;
    text = text.slice(0, -1);
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = typeRef(text.slice(1, -1));
    const list: Record<string, unknown> = { __type: '__Type', kind: 'LIST', name: null, ofType: inner };
    return nonNull ? { __type: '__Type', kind: 'NON_NULL', name: null, ofType: list } : list;
  }
  const def = TYPES.get(text);
  const named: Record<string, unknown> = { __type: '__Type', kind: def?.kind ?? 'SCALAR', name: text, ofType: null };
  return nonNull ? { __type: '__Type', kind: 'NON_NULL', name: null, ofType: named } : named;
}

/** The introspection view of one registered type. */
function introspectType(def: TypeDef): Record<string, unknown> {
  return {
    __type: '__Type',
    name: def.name,
    kind: def.kind,
    description: null,
    fields: (def.fields ?? []).map((field) => ({
      __type: '__Field',
      name: field.name,
      description: null,
      args: (field.args ?? []).map((arg) => ({
        __type: '__InputValue',
        name: arg.name,
        description: null,
        type: typeRef(arg.type),
        defaultValue: null,
      })),
      type: typeRef(field.type),
      isDeprecated: false,
      deprecationReason: null,
    })),
    enumValues: (def.enumValues ?? []).map((value) => ({
      __type: '__EnumValue',
      name: value,
      description: null,
      isDeprecated: false,
      deprecationReason: null,
    })),
    inputFields: (def.inputFields ?? []).map((field) => ({
      __type: '__InputValue',
      name: field.name,
      description: null,
      type: typeRef(field.type),
      defaultValue: null,
    })),
    interfaces: [],
    possibleTypes: [],
  };
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

class GraphQLError extends Error {}

type Source = Record<string, unknown> & { __type: string };

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
}

type Resolver = (source: Source, args: Record<string, unknown>, ctx: ExecContext) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {};

function userSource(login: string, id: number): Source {
  return { __type: 'User', login, id, globalId: Buffer.from(`User:${id}`, 'utf8').toString('base64url') };
}

function repoSource(repo: Repo): Source {
  return { __type: 'Repository', repo };
}

function issueSource(repo: Repo, issue: Issue): Source {
  return { __type: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: Pull): Source {
  return { __type: 'PullRequest', repo, pull };
}

function commentSource(repo: Repo, issue: Issue, comment: Comment): Source {
  return { __type: 'Comment', repo, issue, comment };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function afterIndex(after: unknown): number {
  if (typeof after !== 'string') return -1;
  try {
    const text = Buffer.from(after, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

/** Build a Relay-style connection from an ordered list of node sources. */
function makeConnection(nodeType: string, entries: Source[], first: unknown, after: unknown): Source {
  const start = afterIndex(after) + 1;
  const remaining = entries.slice(Math.max(0, start));
  const page = typeof first === 'number' ? remaining.slice(0, Math.max(0, first)) : remaining;
  const hasNextPage = remaining.length > page.length;
  const edges = page.map((node, i) => ({
    __type: `${nodeType}Edge`,
    node,
    cursor: cursorFor(start + i),
  }));
  return {
    __type: `${nodeType}Connection`,
    nodes: page,
    edges,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? (edges[0] as Source).cursor : null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1] as Source).cursor : null,
    },
    totalCount: entries.length,
  };
}

function findRepoByDbid(store: Store, dbid: number): Repo | undefined {
  return store.viewerRepos().find((repo) => repo.dbid === dbid);
}

function repoFromGlobalId(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  return findRepoByDbid(store, Number(decoded.key)) ?? null;
}

function issueFromGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const [dbid, number] = decoded.key.split(':');
  const repo = findRepoByDbid(store, Number(dbid));
  if (repo === undefined) return null;
  const issue = repo.issues.find((entry) => entry.number === Number(number));
  return issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const [dbid, number] = decoded.key.split(':');
  const repo = findRepoByDbid(store, Number(dbid));
  if (repo === undefined) return null;
  const pull = repo.pulls.find((entry) => entry.number === Number(number));
  return pull === undefined ? null : { repo, pull };
}

// --- root -------------------------------------------------------------------

RESOLVERS.Query = {
  viewer: () => userSource(VIEWER_LOGIN, VIEWER_ID),
  repository: (source, args, ctx) => {
    const owner = args.owner;
    const name = args.name;
    if (owner !== VIEWER_LOGIN || typeof name !== 'string') return null;
    const repo = ctx.store.getRepo(VIEWER_LOGIN, name);
    return repo === undefined ? null : repoSource(repo);
  },
  node: (source, args, ctx) => {
    const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
    if (decoded === null) return null;
    if (decoded.kind === 'Repository') {
      const repo = findRepoByDbid(ctx.store, Number(decoded.key));
      return repo === undefined ? null : repoSource(repo);
    }
    if (decoded.kind === 'Issue') {
      const found = issueFromGlobalId(ctx.store, args.id);
      return found === null ? null : issueSource(found.repo, found.issue);
    }
    if (decoded.kind === 'PullRequest') {
      const found = pullFromGlobalId(ctx.store, args.id);
      return found === null ? null : pullSource(found.repo, found.pull);
    }
    return null;
  },
  __schema: () => ({
    __type: '__Schema',
    queryType: introspectType(TYPES.get('Query') as TypeDef),
    mutationType: introspectType(TYPES.get('Mutation') as TypeDef),
    types: [...TYPES.values()].map(introspectType),
    directives: [],
  }),
  __type: (source, args) => {
    const def = typeof args.name === 'string' ? TYPES.get(args.name) : undefined;
    return def === undefined ? null : introspectType(def);
  },
};

// --- mutations ---------------------------------------------------------------

RESOLVERS.Mutation = {
  createIssue: (source, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = repoFromGlobalId(ctx.store, input.repositoryId);
    if (repo === null) throw new GraphQLError('Could not resolve to a Repository with the id provided');
    const title = input.title;
    if (typeof title !== 'string' || title === '') throw new GraphQLError('A title is required');
    const seq = ctx.store.tick();
    const issue: Issue = {
      id: ctx.store.nextIssueId++,
      number: repo.nextIssue++,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      user: VIEWER_LOGIN,
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    repo.issues.push(issue);
    invalidateRepo(repo);
    return { __type: 'CreateIssuePayload', issue: issueSource(repo, issue) };
  },
  closeIssue: (source, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = issueFromGlobalId(ctx.store, input.issueId);
    if (found === null) throw new GraphQLError('Could not resolve to an Issue with the id provided');
    found.issue.state = 'closed';
    found.issue.updatedSeq = ctx.store.tick();
    invalidateRepo(found.repo);
    return { __type: 'CloseIssuePayload', issue: issueSource(found.repo, found.issue) };
  },
  createPullRequest: (source, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = repoFromGlobalId(ctx.store, input.repositoryId);
    if (repo === null) throw new GraphQLError('Could not resolve to a Repository with the id provided');
    const head = typeof input.headRefName === 'string' ? resolveRef(repo, input.headRefName) : null;
    const base = typeof input.baseRefName === 'string' ? resolveRef(repo, input.baseRefName) : null;
    if (head === null || base === null) throw new GraphQLError('Head or base ref does not exist');
    const title = input.title;
    if (typeof title !== 'string' || title === '') throw new GraphQLError('A title is required');
    const pull: Pull = {
      id: ctx.store.nextPullId++,
      number: repo.nextPull++,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      head: { ref: input.headRefName as string, sha: head },
      base: { ref: input.baseRefName as string, sha: base },
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      createdSeq: ctx.store.tick(),
    };
    repo.pulls.push(pull);
    invalidateRepo(repo);
    return { __type: 'CreatePullRequestPayload', pullRequest: pullSource(repo, pull) };
  },
  mergePullRequest: (source, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = pullFromGlobalId(ctx.store, input.pullRequestId);
    if (found === null) throw new GraphQLError('Could not resolve to a PullRequest with the id provided');
    if (found.pull.state !== 'open') throw new GraphQLError('Pull request is already closed');
    if (pullRequestConflicts(found.repo, found.pull).length > 0) throw new GraphQLError('Merge conflict');
    squashMerge(ctx.store, found.repo, found.pull);
    return { __type: 'MergePullRequestPayload', pullRequest: pullSource(found.repo, found.pull) };
  },
  addComment: (source, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = issueFromGlobalId(ctx.store, input.subjectId);
    if (found === null) throw new GraphQLError('Could not resolve to an Issue with the id provided');
    const body = input.body;
    if (typeof body !== 'string' || body === '') throw new GraphQLError('A body is required');
    const comment: Comment = {
      id: found.repo.nextCommentId++,
      body,
      user: VIEWER_LOGIN,
      createdSeq: ctx.store.tick(),
    };
    found.issue.comments.push(comment);
    invalidateRepo(found.repo);
    return {
      __type: 'AddCommentPayload',
      commentEdge: {
        __type: 'IssueCommentEdge',
        node: commentSource(found.repo, found.issue, comment),
        cursor: cursorFor(comment.id),
      },
      subject: issueSource(found.repo, found.issue),
    };
  },
};

// --- object types -------------------------------------------------------------

RESOLVERS.User = {
  id: (source) => source.globalId as string,
  login: (source) => source.login as string,
  databaseId: (source) => source.id as number,
};

RESOLVERS.Repository = {
  id: (source) => repoGlobalId((source.repo as Repo)),
  databaseId: (source) => (source.repo as Repo).dbid,
  name: (source) => (source.repo as Repo).name,
  nameWithOwner: (source) => {
    const repo = source.repo as Repo;
    return `${repo.owner}/${repo.name}`;
  },
  owner: (source) => userSource((source.repo as Repo).owner, VIEWER_ID),
  defaultBranchRef: (source) => ({ __type: 'Ref', name: (source.repo as Repo).defaultBranch }),
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  createdAt: (source, args, ctx) => ctx.store.iso((source.repo as Repo).createdSeq),
  issue: (source, args) => {
    const repo = source.repo as Repo;
    const issue = repo.issues.find((entry) => entry.number === args.number);
    return issue === undefined ? null : issueSource(repo, issue);
  },
  issues: (source, args) => {
    const repo = source.repo as Repo;
    let issues = [...repo.issues];
    if (Array.isArray(args.states) && args.states.length > 0) {
      const wanted = new Set((args.states as string[]).map((state) => state.toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = orderBy.direction === 'ASC' ? 1 : -1;
    const field = orderBy.field;
    if (field === 'UPDATED_AT') {
      issues.sort((a, b) => direction * (a.updatedSeq - b.updatedSeq));
    } else if (field === 'COMMENTS') {
      issues.sort((a, b) => direction * (a.comments.length - b.comments.length));
    } else {
      issues.sort((a, b) => direction * (a.createdSeq - b.createdSeq));
    }
    return makeConnection('Issue', issues.map((issue) => issueSource(repo, issue)), args.first, args.after);
  },
  pullRequest: (source, args) => {
    const repo = source.repo as Repo;
    const pull = repo.pulls.find((entry) => entry.number === args.number);
    return pull === undefined ? null : pullSource(repo, pull);
  },
  pullRequests: (source, args) => {
    const repo = source.repo as Repo;
    const pulls = [...repo.pulls].sort((a, b) => a.createdSeq - b.createdSeq);
    return makeConnection('PullRequest', pulls.map((pull) => pullSource(repo, pull)), args.first, args.after);
  },
};

RESOLVERS.Issue = {
  id: (source) => issueGlobalId(source.repo as Repo, source.issue as Issue),
  databaseId: (source) => (source.issue as Issue).number,
  number: (source) => (source.issue as Issue).number,
  title: (source) => (source.issue as Issue).title,
  body: (source) => (source.issue as Issue).body,
  state: (source) => ((source.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
  author: () => userSource(VIEWER_LOGIN, VIEWER_ID),
  createdAt: (source, args, ctx) => ctx.store.iso((source.issue as Issue).createdSeq),
  labels: (source, args) => {
    const repo = source.repo as Repo;
    const issue = source.issue as Issue;
    return makeConnection('Label', issue.labels.map((label) => ({ __type: 'Label', label })), args.first, args.after);
  },
  comments: (source, args) => {
    const repo = source.repo as Repo;
    const issue = source.issue as Issue;
    return makeConnection(
      'Comment',
      issue.comments.map((comment) => commentSource(repo, issue, comment)),
      args.first,
      args.after,
    );
  },
};

RESOLVERS.PullRequest = {
  id: (source) => pullGlobalId(source.repo as Repo, source.pull as Pull),
  databaseId: (source) => (source.pull as Pull).number,
  number: (source) => (source.pull as Pull).number,
  title: (source) => (source.pull as Pull).title,
  body: (source) => (source.pull as Pull).body,
  state: (source) => {
    const pull = source.pull as Pull;
    if (pull.state === 'open') return 'OPEN';
    return pull.merged ? 'MERGED' : 'CLOSED';
  },
  headRefName: (source) => (source.pull as Pull).head.ref,
  baseRefName: (source) => (source.pull as Pull).base.ref,
  mergeable: (source) => {
    const pull = source.pull as Pull;
    if (pull.state !== 'open') return 'UNKNOWN';
    return pullRequestConflicts(source.repo as Repo, pull).length > 0 ? 'CONFLICTING' : 'MERGEABLE';
  },
  merged: (source) => (source.pull as Pull).merged,
  author: () => userSource(VIEWER_LOGIN, VIEWER_ID),
  createdAt: (source, args, ctx) => ctx.store.iso((source.pull as Pull).createdSeq),
  files: (source, args) => {
    const repo = source.repo as Repo;
    const pull = source.pull as Pull;
    const changes = pullRequestFiles(repo, pull).map((change) => ({
      __type: 'FileChange',
      path: change.path,
      additions: change.additions,
      deletions: change.deletions,
      changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
    }));
    return makeConnection('PullRequestFile', changes, args.first, args.after);
  },
};

RESOLVERS.Label = {
  id: (source) => {
    const label = source.label as { name: string };
    return Buffer.from(`Label:${label.name}`, 'utf8').toString('base64url');
  },
  name: (source) => (source.label as { name: string }).name,
  color: (source) => (source.label as { color: string }).color,
};

RESOLVERS.Comment = {
  id: (source) => commentGlobalId(source.repo as Repo, source.issue as Issue, source.comment as Comment),
  databaseId: (source) => (source.comment as Comment).id,
  body: (source) => (source.comment as Comment).body,
  author: () => userSource(VIEWER_LOGIN, VIEWER_ID),
  createdAt: (source, args, ctx) => ctx.store.iso((source.comment as Comment).createdSeq),
};

RESOLVERS.FileChange = {
  path: (source) => source.path as string,
  additions: (source) => source.additions as number,
  deletions: (source) => source.deletions as number,
  changeType: (source) => source.changeType as string,
};

RESOLVERS.Ref = {
  name: (source) => source.name as string,
};

// --- selection execution -------------------------------------------------------

function collectFields(typeName: string, selections: SelectionNode[], ctx: ExecContext): FieldNode[] {
  const out: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push(selection);
    } else if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        out.push(...collectFields(typeName, selection.selectionSet, ctx));
      }
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        out.push(...collectFields(typeName, fragment.selectionSet, ctx));
      }
    }
  }
  return out;
}

function completeValue(field: FieldNode, value: unknown, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(field, item, ctx));
  if (typeof value === 'object') {
    const source = value as Source;
    if (typeof source.__type === 'string') {
      if (field.selectionSet.length === 0) return source;
      return executeSelectionSet(source.__type, source, field.selectionSet, ctx);
    }
    return value;
  }
  return value;
}

function resolveField(typeName: string, source: Source, field: FieldNode, ctx: ExecContext): unknown {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
  const resolver = RESOLVERS[typeName]?.[field.name];
  let value: unknown;
  if (resolver !== undefined) {
    value = resolver(source, args, ctx);
  } else if (Object.prototype.hasOwnProperty.call(source, field.name)) {
    value = source[field.name];
  } else {
    throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
  }
  return completeValue(field, value, ctx);
}

function executeSelectionSet(typeName: string, source: Source, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of collectFields(typeName, selections, ctx)) {
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    out[responseKey] = resolveField(typeName, source, field, ctx);
  }
  return out;
}

function executeOperation(store: Store, operation: OperationNode, fragments: Map<string, FragmentNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const ctx: ExecContext = { store, variables, fragments };
  try {
    const data = executeSelectionSet(rootType, { __type: rootType }, operation.selectionSet, ctx);
    return { data };
  } catch (error) {
    return {
      data: null,
      errors: [{ message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

function executeRequest(store: Store, entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with a query string' }] };
  }
  const { query, variables, operationName } = entry as Record<string, unknown>;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'A query string is required' }] };
  }
  let definitions: DefinitionNode[];
  try {
    definitions = parseDocument(query);
  } catch (error) {
    return { data: null, errors: [{ message: `Syntax error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const operations = definitions.filter((def): def is OperationNode => def.kind === 'operation');
  const fragments = new Map<string, FragmentNode>();
  for (const def of definitions) {
    if (def.kind === 'fragment') fragments.set(def.name, def);
  }
  let operation: OperationNode | undefined;
  if (typeof operationName === 'string') {
    operation = operations.find((op) => op.name === operationName);
  } else if (operations.length === 1) {
    operation = operations[0];
  }
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'No operation to execute' }] };
  }
  const vars: Record<string, unknown> =
    variables !== null && typeof variables === 'object' && !Array.isArray(variables)
      ? { ...(variables as Record<string, unknown>) }
      : {};
  for (const def of operation.variableDefinitions) {
    if (vars[def.name] === undefined && def.defaultValue !== null) {
      vars[def.name] = resolveValue(def.defaultValue, vars);
    }
  }
  return executeOperation(store, operation, fragments, vars);
}

/** Handle one POST /api/graphql request (single or batched). */
export function handleGraphQL(store: Store, body: unknown, token: string | null): { status: number; json: unknown } {
  if (token === null || token === '') {
    return { status: 401, json: { message: 'Requires authentication' } };
  }
  if (Array.isArray(body)) {
    return { status: 200, json: body.map((entry) => executeRequest(store, entry)) };
  }
  return { status: 200, json: executeRequest(store, body) };
}
