// mcp.ts — Model Context Protocol over Streamable HTTP, revision 2026-07-28.
//
// The suite's client probes `server/discover` first (the modern era: no
// handshake, no session), and falls back to the `initialize` handshake for
// older revisions. Both speak here. Tools act on the same store the REST
// surface reads, so an issue created over MCP is the same object over REST.

import { VIEWER, type Repo, type Store } from './store.ts';

export const MCP_REVISION = '2026-07-28';
export const SERVER_NAME = 'git-forge';
export const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (args: Record<string, unknown>, store: Store) => Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (args, store) => {
      const name = String(args.name ?? '');
      if (name === '') throw new ToolError('name is required');
      if (store.getRepo(VIEWER.login, name)) throw new ToolError(`repository ${VIEWER.login}/${name} already exists`);
      const repo = store.createRepo(VIEWER.login, name, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return repoObject(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (args, store) => {
      const repo = requireRepo(args, store);
      return repoObject(repo);
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (args, store) => {
      const repo = requireRepo(args, store);
      const title = String(args.title ?? '');
      if (title === '') throw new ToolError('title is required');
      const issue = store.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return issueObject(issue, repo);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    run: (args, store) => {
      const repo = requireRepo(args, store);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { issues: list.map((issue) => issueObject(issue, repo)) };
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (args, store) => {
      const repo = requireRepo(args, store);
      const number = Number(args.issue_number);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (!issue) throw new ToolError(`issue #${number} not found`);
      return issueObject(issue, repo);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (args, store) => {
      const repo = requireRepo(args, store);
      const title = String(args.title ?? '');
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      if (title === '' || head === '' || base === '') throw new ToolError('title, head and base are required');
      const headSha = store.resolveRef(repo, head);
      const baseSha = store.resolveRef(repo, base);
      if (!headSha) throw new ToolError(`head ${head} does not exist`);
      if (!baseSha) throw new ToolError(`base ${base} does not exist`);
      const pull = store.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, headSha, base, baseSha);
      return pullObject(pull, repo);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (args, store) => {
      const repo = requireRepo(args, store);
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) throw new ToolError(`pull request #${number} not found`);
      if (pull.merged) throw new ToolError(`pull request #${number} is already merged`);
      const sha = store.squashMerge(repo, pull);
      if (sha === null) throw new ToolError('merge conflict: the pull request cannot be merged cleanly');
      return { merged: true, sha, message: 'Pull request successfully merged', number };
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    run: (_args, store) => ({ repos: store.listViewerRepos().map(repoObject) }),
  },
];

class ToolError extends Error {}

function requireRepo(args: Record<string, unknown>, store: Store): Repo {
  const owner = String(args.owner ?? '');
  const name = String(args.repo ?? args.name ?? '');
  if (owner === '' || name === '') throw new ToolError('owner and repo are required');
  const repo = store.getRepo(owner, name);
  if (!repo || owner !== VIEWER.login) throw new ToolError(`repository ${owner}/${name} not found`);
  return repo;
}

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
  };
}

function issueObject(issue: Repo['issues'][number], repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name })),
    user: { login: issue.userLogin },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(pull: Repo['pulls'][number], repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: pull.userLogin },
    created_at: pull.createdAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function toolList(): Array<Record<string, unknown>> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

export interface McpReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result }, headers: { 'content-type': 'application/json' } };
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): McpReply {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } }, headers: { 'content-type': 'application/json' } };
}

function serverInfo(): Record<string, unknown> {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    capabilities: { tools: {} },
    supportedVersions: [MCP_REVISION, '2025-11-25'],
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Handle one POST /mcp body (already read as text). */
export function handleMcp(rawBody: string, store: Store): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
    return rpcError(isRecord(parsed) ? (parsed.id as JsonRpcId) ?? null : null, -32600, 'Invalid Request');
  }
  const id = (parsed.id ?? null) as JsonRpcId;
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};

  // Notifications carry no id: acknowledge and stop.
  if (id === null && parsed.id === undefined) {
    return { status: 202, body: '' };
  }

  switch (method) {
    case 'server/discover':
      return rpcResult(id, serverInfo());
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
      const negotiated = requested === MCP_REVISION || requested === '2025-11-25' ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'tools/list':
      return rpcResult(id, { tools: toolList() });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) {
        return rpcError(id, -32601, `Method not found: ${name}`);
      }
      const missing = tool.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
      if (missing.length > 0) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }],
          isError: true,
        });
      }
      try {
        const result = tool.run(args, store);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return rpcResult(id, {
          content: [{ type: 'text', text: message }],
          isError: true,
        });
      }
    }
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
