// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests. One store, no database, no network.
//
// Shapes follow what the suite's rest-client asserts: status codes, the fields
// it reads back, pagination through Link rel="next", and JSON error bodies with
// a string `message`. Anything unlisted here is answered 404 by the router.

import {
  VIEWER,
  flattenTree,
  gid,
  isoOf,
  isOid,
  nextEpochSec,
  parseCommit,
  parseTree,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestContext {
  method: string;
  /** URL-decoded path segments after `/api/v3`. */
  parts: string[];
  query: URLSearchParams;
  body: unknown;
  /** Absolute origin of this request, for pagination Link headers. */
  origin: string;
}

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestReply => ({ status, body, headers });
const err = (status: number, message: string): RestReply => json(status, { message });
const notFound = (what = 'Not Found'): RestReply => err(404, what);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(body: unknown, field: string): string {
  if (!isRecord(body)) return '';
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function bodyBool(body: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function userView(login: string): Record<string, unknown> {
  return { login, id: VIEWER.id, node_id: gid('user', login), type: 'User', site_admin: false };
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.globalId,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userView(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
    watchers_count: 0,
    databaseId: repo.dbId,
  };
}

function labelView(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

function issueView(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelView),
    user: userView(issue.userLogin),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentView(comment: Issue['comments'][number], repo: Repo, issueNumber: number): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.globalId,
    body: comment.body,
    user: userView(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
  };
}

function pullView(pull: PullRequest, repo: Repo, mergeable?: boolean): Record<string, unknown> {
  const merged = pull.merged;
  return {
    id: pull.id,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userView(repo.owner),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userView(repo.owner),
    },
    merged,
    mergeable: mergeable ?? !merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userView(pull.userLogin),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, origin: string, path: string): { items: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const urlFor = (p: number): string => `${origin}${path}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(page - 1)}>; rel="prev"`, `<${urlFor(1)}>; rel="first"`);
  }
  if (links.length > 0) headers.link = links.join(', ');
  return { items: slice as T[], headers };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function handleRest(ctx: RestContext, store: Store): RestReply | null {
  const { method, parts } = ctx;

  // API root and meta.
  if (parts.length === 0) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{username}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (parts.length === 1 && parts[0] === 'meta') {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }
  if (parts.length === 1 && parts[0] === 'user') {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return json(200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: gid('user', VIEWER.login),
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
    });
  }
  if (parts.length === 2 && parts[0] === 'users') {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    if (parts[1] !== VIEWER.login) return notFound('User not found');
    return json(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }

  // POST /user/repos, GET /user/repos.
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'POST') return createRepo(ctx, store);
    if (method === 'GET') {
      const repos = store.listViewerRepos();
      const page = paginate(repos.map(repoView), ctx.query, ctx.origin, '/api/v3/user/repos');
      return json(200, page.items, page.headers);
    }
    return err(405, 'Method Not Allowed');
  }

  // /repos/{owner}/{repo}[...]
  if (parts.length >= 3 && parts[0] === 'repos') {
    const owner = parts[1]!;
    const name = parts[2]!;
    const repo = store.getRepo(owner, name);
    if (!repo || owner !== VIEWER.login) {
      // A repository belongs to the login the token names; anything else is 404.
      if (method === 'GET' || method === 'PATCH' || method === 'DELETE' || method === 'PUT' || method === 'POST') {
        return notFound('Not Found');
      }
      return notFound();
    }
    const tail = parts.slice(3);
    if (tail.length === 0) return repoRoot(ctx, store, repo);
    if (tail[0] === 'branches') return branches(ctx, store, repo, tail.slice(1));
    if (tail[0] === 'commits') return commits(ctx, store, repo);
    if (tail[0] === 'git' && tail[1] === 'refs') return gitRefs(ctx, store, repo, tail.slice(2));
    if (tail[0] === 'contents') return contents(ctx, store, repo, tail.slice(1));
    if (tail[0] === 'labels') return labels(ctx, store, repo);
    if (tail[0] === 'issues') return issues(ctx, store, repo, tail.slice(1));
    if (tail[0] === 'pulls') return pulls(ctx, store, repo, tail.slice(1));
    return notFound();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

function createRepo(ctx: RestContext, store: Store): RestReply {
  if (!isRecord(ctx.body)) return err(422, 'Validation Failed: name is required');
  const name = bodyString(ctx.body, 'name');
  if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    return err(422, 'Validation Failed: name is invalid');
  }
  if (store.getRepo(VIEWER.login, name)) {
    return err(422, `Repository ${VIEWER.login}/${name} already exists`);
  }
  const repo = store.createRepo(VIEWER.login, name, {
    description: bodyString(ctx.body, 'description'),
    isPrivate: bodyBool(ctx.body, 'private', false),
    defaultBranch: bodyString(ctx.body, 'default_branch') || undefined,
  });
  return json(201, repoView(repo));
}

function repoRoot(ctx: RestContext, store: Store, repo: Repo): RestReply {
  if (ctx.method === 'GET') return json(200, repoView(repo));
  if (ctx.method === 'PATCH') {
    if (!isRecord(ctx.body)) return err(422, 'Validation Failed');
    if (typeof ctx.body.description === 'string') repo.description = ctx.body.description;
    if (typeof ctx.body.private === 'boolean') repo.isPrivate = ctx.body.private;
    return json(200, repoView(repo));
  }
  if (ctx.method === 'DELETE') {
    store.deleteRepo(repo.owner, repo.name);
    return { status: 204, body: null };
  }
  return err(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------------------
// Branches and commits
// ---------------------------------------------------------------------------

function branches(ctx: RestContext, store: Store, repo: Repo, tail: string[]): RestReply {
  if (ctx.method === 'GET' && tail.length === 0) {
    const list = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(ref)! },
        protected: false,
      }));
    return json(200, list);
  }
  if (ctx.method === 'GET' && tail.length === 1) {
    const ref = `refs/heads/${tail[0]}`;
    const tip = repo.refs.get(ref);
    if (!tip) return notFound('Branch not found');
    return json(200, { name: tail[0], commit: { sha: tip }, protected: false });
  }
  return err(405, 'Method Not Allowed');
}

function commits(ctx: RestContext, store: Store, repo: Repo): RestReply {
  if (ctx.method !== 'GET') return err(405, 'Method Not Allowed');
  const refParam = ctx.query.get('sha');
  const tip = refParam ? store.resolveRef(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (!tip) return json(200, []);
  const list = store.listCommits(repo, tip).map(({ sha, commit }) => {
    const match = /^(.+) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(commit.author);
    const name = match?.[1] ?? '';
    const email = match?.[2] ?? '';
    const epoch = Number(match?.[3] ?? 0);
    return {
      sha,
      commit: {
        // Git stores the message with a trailing newline; the API shows it without.
        message: commit.message.replace(/\n$/, ''),
        author: { name, email, date: isoOf(epoch) },
        committer: { name, email, date: isoOf(epoch) },
      },
      author: { login: VIEWER.login },
      committer: { login: VIEWER.login },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  });
  const page = paginate(list, ctx.query, ctx.origin, `/api/v3/repos/${repo.owner}/${repo.name}/commits`);
  return json(200, page.items, page.headers);
}

// ---------------------------------------------------------------------------
// Git refs
// ---------------------------------------------------------------------------

function gitRefs(ctx: RestContext, store: Store, repo: Repo, tail: string[]): RestReply {
  if (ctx.method === 'POST' && tail.length === 0) {
    if (!isRecord(ctx.body)) return err(422, 'Validation Failed');
    const ref = bodyString(ctx.body, 'ref');
    const sha = bodyString(ctx.body, 'sha');
    if (!ref.startsWith('refs/') || !isOid(sha)) return err(422, 'Validation Failed: ref and sha are required');
    if (repo.refs.has(ref)) return err(422, `Reference ${ref} already exists`);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') return err(422, 'Validation Failed: sha is not a commit');
    repo.refs.set(ref, sha);
    return json(201, { ref, object: { sha, type: 'commit' } });
  }
  if (ctx.method === 'GET' && tail.length === 0) {
    const list = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => ({
      ref,
      object: { sha, type: 'commit' },
    }));
    return json(200, list);
  }
  if (ctx.method === 'GET' && tail.length >= 2 && tail[0] === 'heads') {
    const branch = tail.slice(1).join('/');
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return notFound('Reference not found');
    return json(200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
  }
  if (ctx.method === 'GET' && tail.length >= 2 && tail[0] === 'tags') {
    const tag = tail.slice(1).join('/');
    const oid = repo.refs.get(`refs/tags/${tag}`);
    if (!oid) return notFound('Reference not found');
    return json(200, { ref: `refs/tags/${tag}`, object: { sha: oid, type: 'tag' } });
  }
  return err(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function contents(ctx: RestContext, store: Store, repo: Repo, tail: string[]): RestReply {
  const path = tail.join('/');
  const refParam = ctx.query.get('ref');
  const branch = refParam ?? repo.defaultBranch;

  if (ctx.method === 'PUT') {
    if (!isRecord(ctx.body)) return err(422, 'Validation Failed');
    const message = bodyString(ctx.body, 'message') || `Update ${path}`;
    const contentB64 = bodyString(ctx.body, 'content');
    if (contentB64 === '') return err(422, 'Validation Failed: content is required');
    const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const putBranch = bodyString(ctx.body, 'branch') || repo.defaultBranch;
    const sha = bodyString(ctx.body, 'sha');
    const refName = `refs/heads/${putBranch}`;
    const tip = repo.refs.get(refName);
    let existing: { oid: string; mode: string } | undefined;
    if (tip) {
      const commit = parseCommit(repo.objects.get(tip)!.data);
      const files = flattenTree(repo.objects, commit.tree);
      existing = files.get(path);
      if (existing) {
        if (sha === '') return err(422, 'Validation Failed: sha is required to update a file');
        if (sha.toLowerCase() !== existing.oid.toLowerCase()) {
          return err(409, 'Conflict: sha does not match the current file');
        }
      } else if (sha !== '') {
        return err(422, 'Validation Failed: sha does not match a file that does not exist');
      }
    } else if (sha !== '') {
      return err(422, 'Validation Failed: sha does not match a file that does not exist');
    }
    // 201 when the file is new on the branch, 200 when it replaces one —
    // regardless of whether the branch itself already existed.
    const created = existing === undefined;
    const { commitSha, blobSha } = store.commitFile(repo, putBranch, path, content, message);
    return json(created ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitSha, message },
    });
  }

  if (ctx.method === 'GET') {
    const tip = store.resolveRef(repo, branch);
    if (!tip) return notFound('Not Found');
    const commit = parseCommit(repo.objects.get(tip)!.data);
    const files = flattenTree(repo.objects, commit.tree);
    if (path === '') {
      const entries = directoryListing(repo, commit.tree, '');
      return json(200, entries);
    }
    const file = files.get(path);
    if (file) {
      const blob = repo.objects.get(file.oid)!;
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop(),
        path,
        content: blob.data.toString('base64'),
        sha: file.oid,
      });
    }
    // A directory: list its direct children.
    const prefix = `${path}/`;
    const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const first = rest.split('/')[0]!;
      if (rest.includes('/')) {
        children.set(first, { type: 'dir', name: first, path: `${path}/${first}`, sha: '' });
      } else {
        children.set(first, { type: 'file', name: first, path: filePath, sha: entry.oid });
      }
    }
    if (children.size === 0) return notFound('Not Found');
    // Directory shas come from the tree object itself.
    const dirEntries = directoryListing(repo, commit.tree, path);
    return json(200, dirEntries.length > 0 ? dirEntries : [...children.values()]);
  }

  if (ctx.method === 'DELETE') {
    if (!isRecord(ctx.body)) return err(422, 'Validation Failed');
    const sha = bodyString(ctx.body, 'sha');
    const message = bodyString(ctx.body, 'message') || `Delete ${path}`;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return notFound('Not Found');
    const commit = parseCommit(repo.objects.get(tip)!.data);
    const files = flattenTree(repo.objects, commit.tree);
    const existing = files.get(path);
    if (!existing) return notFound('Not Found');
    if (sha !== '' && sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return err(409, 'Conflict: sha does not match the current file');
    }
    const deleted = store.deleteFile(repo, branch, path, message);
    if (!deleted) return notFound('Not Found');
    return json(200, { commit: { sha: deleted.commitSha, message } });
  }

  return err(405, 'Method Not Allowed');
}

function directoryListing(repo: Repo, treeOid: string, dirPath: string): Array<Record<string, unknown>> {
  let current = treeOid;
  if (dirPath !== '') {
    const segments = dirPath.split('/');
    for (const segment of segments) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'tree') return [];
      const entry = parseTree(obj.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (!entry) return [];
      current = entry.oid;
    }
  }
  const obj = repo.objects.get(current);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function labels(ctx: RestContext, store: Store, repo: Repo): RestReply {
  if (ctx.method === 'GET') {
    return json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
  }
  if (ctx.method === 'POST') {
    if (!isRecord(ctx.body)) return err(422, 'Validation Failed');
    const name = bodyString(ctx.body, 'name');
    if (name === '') return err(422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) return err(422, `Label ${name} already exists`);
    const color = bodyString(ctx.body, 'color') || 'ededed';
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return json(201, { name, color, description: '' });
  }
  return err(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function issues(ctx: RestContext, store: Store, repo: Repo, tail: string[]): RestReply {
  if (tail.length === 0) {
    if (ctx.method === 'POST') return createIssue(ctx, store, repo);
    if (ctx.method === 'GET') return listIssues(ctx, store, repo);
    return err(405, 'Method Not Allowed');
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return notFound('Not Found');
  const issue = repo.issues.find((entry) => entry.number === number);
  if (!issue) return notFound('Not Found');
  if (tail.length === 1) {
    if (ctx.method === 'GET') return json(200, issueView(issue, repo));
    if (ctx.method === 'PATCH') {
      if (!isRecord(ctx.body)) return err(422, 'Validation Failed');
      const state = bodyString(ctx.body, 'state');
      if (state === 'open' || state === 'closed') {
        issue.state = state;
        issue.closedAt = state === 'closed' ? isoOf(nextEpochSec()) : null;
        issue.updatedAt = isoOf(nextEpochSec());
      }
      if (typeof ctx.body.title === 'string') issue.title = ctx.body.title;
      if (typeof ctx.body.body === 'string') issue.body = ctx.body.body;
      return json(200, issueView(issue, repo));
    }
    return err(405, 'Method Not Allowed');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (ctx.method === 'POST') {
      if (!isRecord(ctx.body)) return err(422, 'Validation Failed');
      const body = bodyString(ctx.body, 'body');
      if (body === '') return err(422, 'Validation Failed: body is required');
      const id = store.nextCommentId();
      const epoch = nextEpochSec();
      const comment: Issue['comments'][number] = {
        id,
        globalId: gid('comment', repo.owner, repo.name, issue.number, id),
        body,
        userLogin: VIEWER.login,
        createdAt: isoOf(epoch),
        seq: epoch,
      };
      issue.comments.push(comment);
      return json(201, commentView(comment, repo, issue.number));
    }
    if (ctx.method === 'GET') {
      return json(200, issue.comments.map((comment) => commentView(comment, repo, issue.number)));
    }
    return err(405, 'Method Not Allowed');
  }
  return notFound();
}

function createIssue(ctx: RestContext, store: Store, repo: Repo): RestReply {
  if (!isRecord(ctx.body)) return err(422, 'Validation Failed');
  const title = bodyString(ctx.body, 'title');
  if (title === '') return err(422, 'Validation Failed: title is required');
  const body = bodyString(ctx.body, 'body');
  const wanted = Array.isArray(ctx.body.labels) ? ctx.body.labels : [];
  const labels: Label[] = [];
  for (const entry of wanted) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) ? bodyString(entry, 'name') : '';
    const label = repo.labels.get(name);
    if (!label) return err(422, `Validation Failed: label ${name} does not exist`);
    labels.push(label);
  }
  const issue = store.createIssue(repo, title, body, labels);
  return json(201, issueView(issue, repo));
}

function listIssues(ctx: RestContext, store: Store, repo: Repo): RestReply {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let list = [...repo.issues];
  if (state === 'open') list = list.filter((issue) => issue.state === 'open');
  else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
  if (sort === 'created') {
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const page = paginate(list.map((issue) => issueView(issue, repo)), ctx.query, ctx.origin, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
  return json(200, page.items, page.headers);
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function pulls(ctx: RestContext, store: Store, repo: Repo, tail: string[]): RestReply {
  if (tail.length === 0) {
    if (ctx.method === 'POST') return createPull(ctx, store, repo);
    if (ctx.method === 'GET') return listPulls(ctx, store, repo);
    return err(405, 'Method Not Allowed');
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return notFound('Not Found');
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (!pull) return notFound('Not Found');
  if (tail.length === 1) {
    if (ctx.method === 'GET') return json(200, pullView(pull, repo, pullMergeableBool(store, repo, pull)));
    return err(405, 'Method Not Allowed');
  }
  if (tail.length === 2 && tail[1] === 'files') {
    if (ctx.method !== 'GET') return err(405, 'Method Not Allowed');
    const files = store.pullFiles(repo, pull);
    return json(200, files.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: '',
    })));
  }
  if (tail.length === 2 && tail[1] === 'merge') {
    if (ctx.method !== 'PUT') return err(405, 'Method Not Allowed');
    return mergePull(ctx, store, repo, pull);
  }
  return notFound();
}

function pullMergeableBool(store: Store, repo: Repo, pull: PullRequest): boolean {
  if (pull.merged) return false;
  return store.pullMergeable(repo, pull) === 'MERGEABLE';
}

function createPull(ctx: RestContext, store: Store, repo: Repo): RestReply {
  if (!isRecord(ctx.body)) return err(422, 'Validation Failed');
  const title = bodyString(ctx.body, 'title');
  const head = bodyString(ctx.body, 'head');
  const base = bodyString(ctx.body, 'base');
  if (title === '' || head === '' || base === '') return err(422, 'Validation Failed: title, head and base are required');
  const headSha = store.resolveRef(repo, head);
  const baseSha = store.resolveRef(repo, base);
  if (!headSha) return err(422, `Validation Failed: head ${head} does not exist`);
  if (!baseSha) return err(422, `Validation Failed: base ${base} does not exist`);
  const existing = repo.pulls.find((entry) => entry.headRef === head && entry.baseRef === base && entry.state === 'open');
  if (existing) return err(422, 'Validation Failed: a pull request already exists for this head and base');
  const pull = store.createPull(repo, title, bodyString(ctx.body, 'body'), head, headSha, base, baseSha);
  return json(201, pullView(pull, repo, true));
}

function listPulls(ctx: RestContext, store: Store, repo: Repo): RestReply {
  const state = ctx.query.get('state') ?? 'open';
  let list = [...repo.pulls];
  if (state === 'open') list = list.filter((pull) => pull.state === 'open');
  else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
  list.sort((a, b) => b.seq - a.seq);
  const page = paginate(list.map((pull) => pullView(pull, repo, pullMergeableBool(store, repo, pull))), ctx.query, ctx.origin, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
  return json(200, page.items, page.headers);
}

function mergePull(ctx: RestContext, store: Store, repo: Repo, pull: PullRequest): RestReply {
  if (pull.merged) return err(405, 'Pull request is already merged');
  if (pull.state === 'closed') return err(405, 'Pull request is closed');
  const method = isRecord(ctx.body) ? bodyString(ctx.body, 'merge_method') : '';
  if (method !== '' && method !== 'squash' && method !== 'merge' && method !== 'rebase') {
    return err(422, `Validation Failed: unknown merge_method ${method}`);
  }
  const mergeSha = store.squashMerge(repo, pull);
  if (mergeSha === null) return err(405, 'Merge conflict: the pull request cannot be merged cleanly');
  return json(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
}
