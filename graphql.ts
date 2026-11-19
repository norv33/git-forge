// graphql.ts — GitHub GraphQL v4 for the documents gh and github-mcp-server send.
//
// A small recursive-descent parser for the query language subset the suite
// uses (operations, variables, aliases, arguments, inline fragments), plus a
// schema-driven executor over the same store the REST surface reads. Unknown
// fields are GraphQL errors (HTTP 200 with an `errors` array), never HTTP 400;
// an unknown repository reads `data.repository = null` with no errors.

import {
  VIEWER,
  gid,
  isoOf,
  nextEpochSec,
  parseGid,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// Schema description (for __type introspection)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'url', 'author', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'url'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Connection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Edge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  Label: ['name', 'color'],
  Comment: ['id', 'body', 'author'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, ValueNode | undefined>;
  selection: SelectionNode[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1]!;
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < source.length && /[A-Za-z0-9_-]/.test(source[j]!)) j += 1;
    if (j === i) throw new Error(`unexpected character ${JSON.stringify(ch)}`);
    tokens.push(source.slice(i, j));
    i = j;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token === 'query' || token === 'mutation') {
        operations.push(this.parseOperation(token));
      } else if (token === '{') {
        this.pos -= 1;
        operations.push({
          kind: 'operation',
          operation: 'query',
          name: null,
          variables: {},
          selection: this.parseSelectionSet(),
        });
      } else if (token === 'fragment') {
        const name = this.next();
        this.expect('on');
        const typeName = this.next();
        void typeName;
        fragments.set(name, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(operation: 'query' | 'mutation'): OperationNode {
    let name: string | null = null;
    const variables: Record<string, ValueNode | undefined> = {};
    const next = this.peek();
    if (next !== undefined && next !== '(' && next !== '{' && next !== '@') {
      name = this.next();
    }
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.next();
        this.expect(':');
        this.parseType();
        if (this.peek() === '=') {
          this.next();
          variables[varName] = this.parseValue();
        }
        if (this.peek() === ')') break;
      }
      this.expect(')');
    }
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.parseArguments();
    }
    return { kind: 'operation', operation, name, variables, selection: this.parseSelectionSet() };
  }

  private parseType(): void {
    const token = this.next();
    if (token === '[') {
      this.parseType();
      this.expect(']');
    }
    if (this.peek() === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        const next = this.peek();
        if (next === 'on') {
          this.next();
          const typeName = this.next();
          selections.push({ kind: 'fragment', typeCondition: typeName, selection: this.parseSelectionSet() });
        } else {
          const name = this.next()!;
          selections.push({ kind: 'fragment', typeCondition: null, selection: [] });
          // Named fragment spread: resolved by the executor via the fragments map.
          (selections[selections.length - 1] as FragmentNode & { spread?: string }).spread = name;
        }
      } else {
        selections.push(this.parseField());
      }
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    const first = this.next();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    }
    const args = this.peek() === '(' ? this.parseArguments() : [];
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.parseArguments();
    }
    const selection = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selection };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expect('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface GqlContext {
  store: Store;
  errors: Array<{ message: string }>;
  fragments: Map<string, SelectionNode[]>;
}

interface TypedValue {
  __typename: string;
  [key: string]: unknown;
}

function userNode(): TypedValue {
  return {
    __typename: 'User',
    id: gid('user', VIEWER.login),
    login: VIEWER.login,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function repoNode(repo: Repo): TypedValue {
  return {
    __typename: 'Repository',
    id: repo.globalId,
    databaseId: repo.dbId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    ownerLogin: repo.owner,
    defaultBranch: repo.defaultBranch,
    hasDefaultBranch: repo.refs.has(`refs/heads/${repo.defaultBranch}`),
    repo,
  };
}

function issueNode(issue: Issue, repo: Repo): TypedValue {
  return {
    __typename: 'Issue',
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    issue,
    repo,
  };
}

function pullNode(pull: PullRequest, repo: Repo): TypedValue {
  return {
    __typename: 'PullRequest',
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    createdAt: pull.createdAt,
    url: `https://example.invalid/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    pull,
    repo,
  };
}

function typeFieldsOf(typeName: string): string[] {
  return TYPE_FIELDS[typeName] ?? [];
}

function resolveField(parent: TypedValue, field: FieldNode, args: Record<string, unknown>, ctx: GqlContext): unknown {
  const typeName = parent.__typename;
  const allowed = typeFieldsOf(typeName);
  if (typeName !== '__Type' && !allowed.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return undefined;
  }
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return userNode();
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = ctx.store.getRepo(owner, name);
        return repo ? repoNode(repo) : null;
      }
      if (field.name === 'node') {
        return resolveNode(String(args.id ?? ''), ctx);
      }
      return null;
    }
    case 'Mutation': {
      return resolveMutation(field.name, args, ctx);
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      switch (field.name) {
        case 'owner':
          return userNode();
        case 'defaultBranchRef':
          return parent.hasDefaultBranch ? { __typename: 'Ref', name: parent.defaultBranch } : null;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = repo.issues.find((entry) => entry.number === args.number);
          return issue ? issueNode(issue, repo) : null;
        }
        case 'issues':
          return issuesConnection(repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.find((entry) => entry.number === args.number);
          return pull ? pullNode(pull, repo) : null;
        }
        case 'pullRequests':
          return pullsConnection(repo, args);
        default:
          return parent[field.name];
      }
    }
    case 'Issue': {
      if (field.name === 'author') return userNode();
      if (field.name === 'labels') {
        const issue = parent.issue as Issue;
        return issue.labels.map((label) => ({ __typename: 'Label', name: label.name }));
      }
      return parent[field.name];
    }
    case 'PullRequest': {
      const pull = parent.pull as PullRequest;
      const repo = parent.repo as Repo;
      if (field.name === 'mergeable') return ctx.store.pullMergeable(repo, pull);
      if (field.name === 'files') {
        const files = ctx.store.pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, first).map((file) => ({
          __typename: 'PullRequestFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          status: file.status.toUpperCase(),
        }));
        const conn = connectionOf(nodes, files.length);
        conn.__typename = 'PullRequestFileConnection';
        return conn;
      }
      return parent[field.name];
    }
    case 'User':
      return parent[field.name];
    case 'Ref':
      return parent[field.name];
    default:
      return parent[field.name];
  }
}

function resolveNode(id: string, ctx: GqlContext): TypedValue | null {
  const parsed = parseGid(id);
  if (!parsed) return null;
  const [owner, name, num] = parsed.parts;
  if (parsed.kind === 'repo' && owner && name) {
    const repo = ctx.store.getRepo(owner, name);
    return repo ? repoNode(repo) : null;
  }
  if ((parsed.kind === 'issue' || parsed.kind === 'pull') && owner && name && num) {
    const repo = ctx.store.getRepo(owner, name);
    if (!repo) return null;
    const number = Number(num);
    if (parsed.kind === 'issue') {
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue ? issueNode(issue, repo) : null;
    }
    const pull = repo.pulls.find((entry) => entry.number === number);
    return pull ? pullNode(pull, repo) : null;
  }
  return null;
}

function connectionOf(nodes: TypedValue[], totalCount: number): TypedValue {
  const last = nodes[nodes.length - 1];
  return {
    __typename: 'Connection',
    nodes,
    edges: nodes.map((node) => ({ __typename: 'Edge', node, cursor: cursorOf(node) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: nodes.length < totalCount,
      hasPreviousPage: false,
      endCursor: last ? cursorOf(last) : null,
      startCursor: nodes.length > 0 ? cursorOf(nodes[0]!) : null,
    },
    totalCount,
  };
}

function cursorOf(node: TypedValue): string {
  const number = typeof node.number === 'number' ? node.number : 0;
  return gid('cursor', number);
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const parsed = parseGid(cursor);
  if (!parsed || parsed.kind !== 'cursor') return null;
  const n = Number(parsed.parts[0]);
  return Number.isFinite(n) ? n : null;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): TypedValue {
  let list = [...repo.issues];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states) {
    list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => (a.seq - b.seq) * direction);
  const after = cursorNumber(args.after);
  if (after !== null) {
    list = list.filter((issue) => (direction === 1 ? issue.number > after : issue.number < after));
  }
  const totalCount = list.length;
  const first = typeof args.first === 'number' ? args.first : totalCount;
  const page = list.slice(0, first);
  const nodes = page.map((issue) => issueNode(issue, repo));
  const conn = connectionOf(nodes, totalCount);
  conn.__typename = 'IssueConnection';
  return conn;
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): TypedValue {
  let list = [...repo.pulls];
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  list = list.filter((pull) => states.includes(pull.state === 'open' ? 'OPEN' : 'CLOSED'));
  list.sort((a, b) => b.seq - a.seq);
  const after = cursorNumber(args.after);
  if (after !== null) list = list.filter((pull) => pull.number < after);
  const totalCount = list.length;
  const first = typeof args.first === 'number' ? args.first : totalCount;
  const page = list.slice(0, first);
  const nodes = page.map((pull) => pullNode(pull, repo));
  const conn = connectionOf(nodes, totalCount);
  conn.__typename = 'PullRequestConnection';
  return conn;
}

function resolveMutation(name: string, args: Record<string, unknown>, ctx: GqlContext): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const repo = findRepoByGid(String(input.repositoryId ?? ''), ctx);
    if (!repo) throw new Error('repository not found');
    const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    return { __typename: 'CreateIssuePayload', issue: issueNode(issue, repo) };
  }
  if (name === 'closeIssue') {
    const found = findIssueByGid(String(input.issueId ?? ''), ctx);
    if (!found) throw new Error('issue not found');
    found.issue.state = 'closed';
    const epoch = nextEpochSec();
    found.issue.closedAt = isoOf(epoch);
    found.issue.updatedAt = isoOf(epoch);
    return { __typename: 'CloseIssuePayload', issue: issueNode(found.issue, found.repo) };
  }
  if (name === 'createPullRequest') {
    const repo = findRepoByGid(String(input.repositoryId ?? ''), ctx);
    if (!repo) throw new Error('repository not found');
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const headSha = ctx.store.resolveRef(repo, head);
    const baseSha = ctx.store.resolveRef(repo, base);
    if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
    const pull = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, headSha, base, baseSha);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(pull, repo) };
  }
  if (name === 'mergePullRequest') {
    const found = findPullByGid(String(input.pullRequestId ?? ''), ctx);
    if (!found) throw new Error('pull request not found');
    ctx.store.squashMerge(found.repo, found.pull);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.pull, found.repo) };
  }
  if (name === 'addComment') {
    const found = findIssueByGid(String(input.subjectId ?? ''), ctx);
    if (!found) throw new Error('issue not found');
    const id = ctx.store.nextCommentId();
    const epoch = nextEpochSec();
    const comment = {
      id,
      globalId: gid('comment', found.repo.owner, found.repo.name, found.issue.number, id),
      body: String(input.body ?? ''),
      userLogin: VIEWER.login,
      createdAt: isoOf(epoch),
      seq: epoch,
    };
    found.issue.comments.push(comment);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'CommentEdge',
        node: { __typename: 'Comment', id: comment.globalId, body: comment.body },
        cursor: gid('cursor', id),
      },
    };
  }
  return null;
}

function findRepoByGid(id: string, ctx: GqlContext): Repo | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'repo') return null;
  const [owner, name] = parsed.parts;
  return owner && name ? (ctx.store.getRepo(owner, name) ?? null) : null;
}

function findIssueByGid(id: string, ctx: GqlContext): { issue: Issue; repo: Repo } | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'issue') return null;
  const [owner, name, num] = parsed.parts;
  if (!owner || !name || !num) return null;
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return null;
  const issue = repo.issues.find((entry) => entry.number === Number(num));
  return issue ? { issue, repo } : null;
}

function findPullByGid(id: string, ctx: GqlContext): { pull: PullRequest; repo: Repo } | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'pull') return null;
  const [owner, name, num] = parsed.parts;
  if (!owner || !name || !num) return null;
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return null;
  const pull = repo.pulls.find((entry) => entry.number === Number(num));
  return pull ? { pull, repo } : null;
}

function executeSelection(
  parent: unknown,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  ctx: GqlContext,
): Record<string, unknown> | null {
  if (parent === null || parent === undefined) return null;
  if (typeof parent !== 'object') return null;
  const out: Record<string, unknown> = {};
  const typed = parent as TypedValue;
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const spread = (selection as FragmentNode & { spread?: string }).spread;
      let sub: SelectionNode[] = selection.selection;
      if (spread) sub = ctx.fragments.get(spread) ?? [];
      if (selection.typeCondition && selection.typeCondition !== typed.__typename) continue;
      const nested = executeSelection(parent, sub, variables, ctx);
      if (nested) Object.assign(out, nested);
      continue;
    }
    const field = selection;
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = resolveValue(arg.value, variables);
    // __type introspection.
    if (field.name === '__type') {
      const typeName = String(args.name ?? '');
      const fields = TYPE_FIELDS[typeName];
      const enumValues = TYPE_ENUM_VALUES[typeName];
      if (!fields && !enumValues) {
        out[field.alias ?? field.name] = null;
        continue;
      }
      const typeNode: TypedValue = {
        __typename: '__Type',
        name: typeName,
        fields: (fields ?? []).map((name) => ({ __typename: '__Field', name })),
        enumValues: (enumValues ?? []).map((name) => ({ __typename: '__EnumValue', name })),
      };
      out[field.alias ?? field.name] = executeSelection(typeNode, field.selection, variables, ctx) ?? typeNode;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(typed, field, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      value = null;
    }
    if (value === undefined) {
      out[field.alias ?? field.name] = null;
      continue;
    }
    if (field.selection.length > 0) {
      if (value === null) {
        out[field.alias ?? field.name] = null;
      } else if (Array.isArray(value)) {
        out[field.alias ?? field.name] = value.map((entry) => executeSelection(entry, field.selection, variables, ctx));
      } else {
        out[field.alias ?? field.name] = executeSelection(value, field.selection, variables, ctx);
      }
    } else {
      out[field.alias ?? field.name] = value;
    }
  }
  return out;
}

export interface GraphQLResult {
  data: unknown;
  errors?: Array<{ message: string }>;
}

/** Execute one {query, variables} operation document. */
export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): GraphQLResult {
  const ctx: GqlContext = { store, errors: [], fragments: new Map() };
  let parsed: { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  ctx.fragments = parsed.fragments;
  const operation = parsed.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'No operation in document' }] };
  const root: TypedValue = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelection(root, operation.selection, variables, ctx);
  if (ctx.errors.length > 0) {
    return { data: data ?? null, errors: ctx.errors };
  }
  return { data };
}
