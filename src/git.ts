import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  constructor(message: string, readonly args: string[], readonly code: number | string | undefined, readonly stdout = '') {
    super(message);
  }
}

export interface GitOptions {
  cwd: string;
  gitPath?: string;
  /** Extra `-c key=value` config passed to every invocation (e.g. user.name). */
  config?: Record<string, string>;
}

export type FileState = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '!' | '?';

export interface StatusEntry {
  path: string;
  /** Previous path for renames/copies. */
  from?: string;
  staged: boolean;
  /** VS Code style letter shown in the list. */
  state: FileState;
  conflict: boolean;
}

export interface Status {
  branch: string | null;         // null when detached
  head: string;                  // short hash or "(initial)"
  upstream: string | null;
  ahead: number;
  behind: number;
  merging: boolean;
  entries: StatusEntry[];
}

export interface Remote { name: string; fetchUrl: string; pushUrl: string }

/** Split `https://[user@]host/path`, `ssh://git@host/path` or `git@host:path` into host + path. Credentials are dropped. */
// ponytail: custom ssh ports are dropped; add a `port` field when someone hosts GitLab on :2222.
export function parseRemoteUrl(url: string): { host: string; path: string } | null {
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(url) ?? /^(?:[^@:/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(url);
  return m ? { host: m[1], path: m[2].replace(/^\/+/, '') } : null;
}
/** HTTPS URL with embedded credentials; git reads them from .git/config so no credential helper is needed. */
export function httpsUrl(host: string, path: string, user: string, secret: string): string {
  return `https://${encodeURIComponent(user)}:${encodeURIComponent(secret)}@${host}/${path}`;
}
export function sshUrl(host: string, path: string): string { return `git@${host}:${path}`; }

/** Messages git/ssh print when the remote rejects our credentials (or asks for ones we cannot type). */
export const AUTH_ERROR = /Authentication failed|could not read (Username|Password)|Permission denied \(publickey|Host key verification failed|Invalid username or (password|token)|HTTP Basic: Access denied|returned error: 40[13]|Repository not found/i;

export interface Branch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream?: string;
  hash: string;
  subject: string;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: Date;
  refs: string[];
  subject: string;
  body: string;
}

export class Git {
  constructor(private opts: GitOptions) {}

  get cwd(): string { return this.opts.cwd; }

  async run(args: string[], input?: string): Promise<string> {
    const cfg = Object.entries(this.opts.config ?? {}).flatMap(([k, v]) => v ? ['-c', `${k}=${v}`] : []);
    // Never let git/ssh pop their own password dialogs: the failure must reach us so the plugin can ask in its own UI.
    const { GIT_ASKPASS, SSH_ASKPASS, SSH_ASKPASS_REQUIRE, ...env } = process.env;
    void GIT_ASKPASS; void SSH_ASKPASS; void SSH_ASKPASS_REQUIRE;
    try {
      const child = execFileAsync(this.opts.gitPath || 'git', [...cfg, ...args], {
        cwd: this.opts.cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
          // No TTY in Electron: ssh cannot ask anything, so fail fast (BatchMode) but still record new host keys.
          GIT_SSH_COMMAND: env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new'
        },
        windowsHide: true
      });
      if (input !== undefined) { child.child.stdin?.end(input); }
      const { stdout } = await child;
      return stdout;
    } catch (e: unknown) {
      const err = e as { stderr?: string; stdout?: string; message: string; code?: number | string };
      throw new GitError((err.stderr || err.stdout || err.message).trim(), args, err.code, err.stdout ?? '');
    }
  }

  static isRepo(dir: string): boolean {
    return fs.existsSync(path.join(dir, '.git'));
  }

  async init(): Promise<void> {
    await this.run(['init']);
  }

  /** Effective config value, '' when unset. Honours `-c` overrides from plugin settings. */
  async config(key: string): Promise<string> {
    return (await this.run(['config', '--get', key]).catch(() => '')).trim();
  }

  async version(): Promise<string> { return (await this.run(['--version'])).trim(); }

  async status(): Promise<Status> {
    const out = await this.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    const st: Status = { branch: null, head: '(initial)', upstream: null, ahead: 0, behind: 0, merging: false, entries: [] };
    const rec = out.split('\0');
    for (let i = 0; i < rec.length; i++) {
      const line = rec[i];
      if (!line) continue;
      if (line.startsWith('# ')) {
        const [key, ...rest] = line.slice(2).split(' ');
        const val = rest.join(' ');
        if (key === 'branch.oid') st.head = val === '(initial)' ? val : val.slice(0, 7);
        else if (key === 'branch.head') st.branch = val === '(detached)' ? null : val;
        else if (key === 'branch.upstream') st.upstream = val;
        else if (key === 'branch.ab') {
          const m = /\+(\d+) -(\d+)/.exec(val);
          if (m) { st.ahead = +m[1]; st.behind = +m[2]; }
        }
        continue;
      }
      const type = line[0];
      if (type === '1' || type === '2') {
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
        const parts = line.split(' ');
        const xy = parts[1];
        const filePath = parts.slice(type === '1' ? 8 : 9).join(' ');
        const from = type === '2' ? rec[++i] : undefined;
        const x = xy[0], y = xy[1];
        if (x !== '.') st.entries.push({ path: filePath, from, staged: true, state: letter(x), conflict: false });
        if (y !== '.') st.entries.push({ path: filePath, staged: false, state: letter(y), conflict: false });
      } else if (type === 'u') {
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
        const parts = line.split(' ');
        st.entries.push({ path: parts.slice(10).join(' '), staged: false, state: 'U', conflict: true });
        st.merging = true;
      } else if (type === '?') {
        st.entries.push({ path: line.slice(2), staged: false, state: '?', conflict: false });
      }
    }
    if (!st.merging) st.merging = fs.existsSync(path.join(this.opts.cwd, '.git', 'MERGE_HEAD'));
    return st;
  }

  add(paths: string[]): Promise<string> { return this.run(['add', '-A', '--', ...paths]); }
  addAll(): Promise<string> { return this.run(['add', '-A']); }
  unstage(paths: string[]): Promise<string> { return this.run(['reset', '-q', 'HEAD', '--', ...paths]); }
  unstageAll(): Promise<string> { return this.run(['reset', '-q']); }

  /** Discard working tree changes: restore tracked files, delete untracked ones. */
  async discard(entries: StatusEntry[]): Promise<void> {
    const untracked = entries.filter(e => e.state === '?').map(e => e.path);
    const tracked = entries.filter(e => e.state !== '?').map(e => e.path);
    if (tracked.length) await this.run(['checkout', '--', ...tracked]);
    if (untracked.length) await this.run(['clean', '-f', '-q', '--', ...untracked]);
  }

  commit(message: string, amend = false): Promise<string> {
    return this.run(['commit', '-q', '-F', '-', ...(amend ? ['--amend'] : [])], message);
  }

  /** VS Code "Undo last commit": keep the changes staged, return the message for the input box. */
  async undoLastCommit(): Promise<string> {
    const message = (await this.run(['log', '-1', '--format=%B'])).trim();
    const hasParent = (await this.run(['rev-list', '--count', 'HEAD'])).trim() !== '1';
    if (hasParent) await this.run(['reset', '-q', '--soft', 'HEAD~1']);
    else await this.run(['update-ref', '-d', 'HEAD']); // the root commit has nothing to reset to
    return message;
  }

  fetch(): Promise<string> { return this.run(['fetch', '--all', '--prune']); }
  pull(): Promise<string> { return this.run(['pull']); }

  async push(status: Status): Promise<string> {
    if (status.upstream || !status.branch) return this.run(['push']);
    // No upstream yet: VS Code offers "publish branch" -> push -u origin <branch>.
    const remotes = await this.remotes();
    if (!remotes.length) throw new GitError('No remote configured. Add one with: git remote add origin <url>', ['push'], undefined);
    return this.run(['push', '-u', remotes[0], status.branch]);
  }

  async remotes(): Promise<string[]> {
    return (await this.run(['remote'])).split('\n').filter(Boolean);
  }

  async remotesVerbose(): Promise<Remote[]> {
    const map = new Map<string, Remote>();
    for (const line of (await this.run(['remote', '-v'])).split('\n')) {
      const m = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(line);
      if (!m) continue;
      const r = map.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' };
      if (m[3] === 'fetch') r.fetchUrl = m[2]; else r.pushUrl = m[2];
      map.set(m[1], r);
    }
    return [...map.values()];
  }
  remoteAdd(name: string, url: string): Promise<string> { return this.run(['remote', 'add', name, url]); }
  remoteRemove(name: string): Promise<string> { return this.run(['remote', 'remove', name]); }
  remoteSetUrl(name: string, url: string): Promise<string> { return this.run(['remote', 'set-url', name, url]); }

  async branches(): Promise<Branch[]> {
    const fmt = ['%(refname)', '%(HEAD)', '%(upstream:short)', '%(objectname:short)', '%(subject)'].join('%1f');
    const out = await this.run(['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads', 'refs/remotes']);
    const list: Branch[] = [];
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [ref, head, upstream, hash, subject] = line.split('\x1f');
      if (ref.endsWith('/HEAD')) continue;
      const remote = ref.startsWith('refs/remotes/');
      const name = ref.replace(/^refs\/(heads|remotes)\//, '');
      list.push({ name, remote, current: head === '*', upstream: upstream || undefined, hash, subject });
    }
    return list;
  }

  /** Switch to a local branch, or create a tracking branch from a remote one. */
  /** Switch to a branch name or a commit hash (the latter leaves HEAD detached). */
  checkoutRef(ref: string): Promise<string> { return this.run(['checkout', ref]); }

  checkout(branch: Branch): Promise<string> {
    if (!branch.remote) return this.checkoutRef(branch.name);
    const local = branch.name.replace(/^[^/]+\//, '');
    return this.run(['checkout', '-b', local, '--track', branch.name]);
  }

  createBranch(name: string): Promise<string> { return this.run(['checkout', '-b', name]); }

  async log(limit = 300): Promise<Commit[]> {
    const fmt = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s', '%b'].join('%x1f') + '%x1e';
    const out = await this.run(['log', '--all', '--date-order', `-n${limit}`, `--format=${fmt}`]).catch(e => {
      if (/does not have any commits|bad default revision/.test(e.message)) return '';
      throw e;
    });
    return out.split('\x1e').map(r => r.replace(/^\n/, '')).filter(r => r.trim()).map(r => {
      const [hash, parents, author, email, at, refs, subject, body] = r.split('\x1f');
      return {
        hash, parents: parents ? parents.split(' ') : [], author, email,
        date: new Date(+at * 1000),
        // `%D` prints "HEAD -> main, origin/main, tag: v1"; keep HEAD as its own label.
        refs: refs ? refs.split(', ').flatMap(s => s.startsWith('HEAD -> ') ? ['HEAD', s.slice(8)] : [s]) : [],
        subject, body: (body ?? '').trim()
      };
    });
  }

  /** Files changed by a commit as `<status>\t<path>` lines. */
  async show(hash: string): Promise<{ status: string; path: string }[]> {
    const out = await this.run(['show', '--name-status', '--format=', '-m', '--first-parent', hash]);
    return out.split('\n').filter(Boolean).map(l => {
      const [status, ...p] = l.split('\t');
      return { status: status[0], path: p[p.length - 1] };
    });
  }

  async diff(filePath: string, staged: boolean): Promise<string> {
    return this.run(['diff', '--no-color', '--no-ext-diff', ...(staged ? ['--cached'] : []), '--', filePath]);
  }

  /** Untracked file: whole content as additions, so the diff view has something to show. */
  async diffUntracked(filePath: string): Promise<string> {
    return this.run(['diff', '--no-color', '--no-index', '--', '/dev/null', filePath]).catch(e => {
      // `--no-index` exits 1 when files differ, which is the normal case.
      if (e instanceof GitError && e.code === 1) return e.stdout;
      throw e;
    });
  }

  mergeAbort(): Promise<string> { return this.run(['merge', '--abort']); }

  /** Merge `branch` into the current one. Conflicts leave the merge in progress for the SCM view to resolve. */
  async merge(branch: string): Promise<string> {
    try {
      return await this.run(['merge', '--no-edit', branch]);
    } catch (e) {
      if (e instanceof GitError && /CONFLICT/.test(e.stdout + e.message)) return 'conflicts to resolve';
      throw e;
    }
  }
}

function letter(c: string): FileState {
  return (c === '?' ? '?' : c) as FileState;
}
