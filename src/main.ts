import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, debounce } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AUTH_ERROR, Git, GitError, type Status } from './git';
import { fixAuth } from './auth';
import { BranchModal, RemotesModal, confirm, prompt } from './ui';
import { SCM_VIEW, ScmView, DIFF_VIEW, DiffView } from './scm-view';
import { GRAPH_VIEW, GraphView } from './graph-view';
import { CONFLICT_VIEW, ConflictView } from './conflict-view';
import { t } from './i18n';

interface Settings {
  gitPath: string;
  extraPath: string;
  authorName: string;
  authorEmail: string;
}
const DEFAULTS: Settings = { gitPath: '', extraPath: '', authorName: '', authorEmail: '' };

export const REFRESH_EVENT = 'git-scm:refresh';
// Shared by every loaded copy of the plugin (a dev reload can leave a stale one alive): two
// syncs at once race on push ("cannot lock ref"), so only one may run per window.
const lock = globalThis as unknown as { gitScmSyncing?: boolean };
const GITIGNORE = `# Obsidian app data: settings, layout, plugins, themes, caches.
# Per-device state that conflicts between machines — the vault syncs content only.
.obsidian/
.trash/

# API client environments: often hold tokens and per-machine URLs
environments/

# OS / editor noise
.DS_Store
Thumbs.db
*.swp
`;

export default class GitPlugin extends Plugin {
  settings: Settings = DEFAULTS;
  git!: Git;
  vaultPath = '';
  status: Status | null = null;
  lastError: string | null = null;
  private statusBar!: HTMLElement;
  private refreshDebounced = debounce(() => void this.refresh(), 500, true);

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) { new Notice(t('Git: desktop only')); return; }
    this.vaultPath = adapter.getBasePath();
    this.makeGit();

    this.registerView(SCM_VIEW, leaf => new ScmView(leaf, this));
    this.registerView(DIFF_VIEW, leaf => new DiffView(leaf, this));
    this.registerView(GRAPH_VIEW, leaf => new GraphView(leaf, this));
    this.registerView(CONFLICT_VIEW, leaf => new ConflictView(leaf, this));
    this.addRibbonIcon('git-pull-request', t('Open Git source control'), () => void this.openView(SCM_VIEW, 'left'));
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass('mod-clickable');
    this.statusBar.onClickEvent(() => void this.switchBranch());

    const cmd = (id: string, name: string, cb: () => unknown) => this.addCommand({ id, name, callback: () => void cb() });
    cmd('open-source-control', t('Open source control'), () => this.openView(SCM_VIEW, 'left'));
    cmd('open-graph', t('Open commit graph'), () => this.openView(GRAPH_VIEW, 'tab'));
    cmd('init', t('Initialize repository'), () => this.initRepo());
    cmd('commit', t('Commit staged changes'), () => this.openView(SCM_VIEW, 'left'));
    cmd('sync', t('Sync'), () => this.sync());
    cmd('push', t('Push'), () => this.push());
    cmd('pull', t('Pull'), () => this.run(t('Pull'), () => this.git.pull()));
    cmd('fetch', t('Fetch'), () => this.run(t('Fetch'), () => this.git.fetch()));
    cmd('switch-branch', t('Switch branch'), () => this.switchBranch());
    cmd('remotes', t('Manage remotes'), () => this.manageRemotes());
    cmd('merge', t('Merge branch into current'), () => this.mergeBranch());
    cmd('undo-commit', t('Undo last commit'), async () => { await this.openView(SCM_VIEW, 'left'); await (this.app.workspace.getLeavesOfType(SCM_VIEW)[0]?.view as ScmView | undefined)?.undoLastCommit(); });
    cmd('stage-all', t('Stage all changes'), () => this.run(t('Stage all'), () => this.git.addAll()));
    cmd('refresh', t('Refresh status'), () => this.refresh(true));
    this.addSettingTab(new GitSettingTab(this.app, this));

    const onChange = () => this.refreshDebounced();
    this.registerEvent(this.app.vault.on('create', onChange));
    this.registerEvent(this.app.vault.on('modify', onChange));
    this.registerEvent(this.app.vault.on('delete', onChange));
    this.registerEvent(this.app.vault.on('rename', onChange));
    // .git itself is outside the vault's watcher (external pushes, CLI commits), so poll lightly too.
    this.registerInterval(window.setInterval(() => void this.refresh(), 30_000));
    this.registerInterval(window.setInterval(() => void this.autoPull(), 60_000));

    this.app.workspace.onLayoutReady(() => {
      void this.refresh().then(() => { if (!this.isRepo) void this.offerInit(); });
    });
  }

  makeGit(): void {
    if (this.settings.extraPath) {
      const parts = process.env.PATH?.split(path.delimiter) ?? [];
      const extra = this.settings.extraPath.split(path.delimiter).filter(p => p && !parts.includes(p));
      if (extra.length) process.env.PATH = [...extra, ...parts].join(path.delimiter);
    }
    this.git = new Git({
      cwd: this.vaultPath,
      gitPath: this.settings.gitPath || undefined,
      config: { 'core.quotepath': 'off', 'user.name': this.settings.authorName, 'user.email': this.settings.authorEmail }
    });
  }

  get isRepo(): boolean { return Git.isRepo(this.vaultPath); }

  private lastSnapshot = '';

  /** Re-read status; views re-render only when something changed (or `force`, after user actions). */
  async refresh(force = false): Promise<void> {
    try {
      this.status = this.isRepo ? await this.git.status() : null;
      this.lastError = null;
    } catch (e) {
      this.status = null;
      this.lastError = (e as Error).message;
    }
    const snapshot = JSON.stringify([this.status, this.lastError]);
    if (!force && snapshot === this.lastSnapshot) return;
    this.lastSnapshot = snapshot;
    const st = this.status;
    this.statusBar.empty();
    if (st) {
      const ab = (st.ahead ? ` ↑${st.ahead}` : '') + (st.behind ? ` ↓${st.behind}` : '');
      this.statusBar.setText(`${st.branch ?? st.head}${ab}${st.merging ? t(' (merging)') : ''}`);
      this.statusBar.setAttribute('aria-label', t('Git: switch branch'));
    }
    this.app.workspace.trigger(REFRESH_EVENT);
  }

  /** Run a git action with a notice on failure, then refresh. */
  async run(label: string, fn: () => Promise<string | void>, quiet = false): Promise<boolean> {
    try {
      const out = await fn();
      if (!quiet) new Notice(t('{label}: {out}', { label, out: (out ?? '').trim().split('\n').filter(Boolean).pop() || t('done') }));
      return true;
    } catch (e) {
      const msg = e instanceof GitError ? e.message : String(e);
      console.error(`git ${label}`, e);
      if (/tell me who you are|Author identity unknown/i.test(msg)) {
        new Notice(t('{label} failed: git needs your name and email first', { label }), 8000);
        await this.ensureIdentity();
      } else if (AUTH_ERROR.test(msg)) {
        await fixAuth(this, label);
      } else new Notice(t('{label} failed:\n{msg}', { label, msg }), 10_000);
      return false;
    } finally {
      await this.refresh(true);
    }
  }

  private autoPulling = false;
  private autoPullError = '';

  /** Background fetch; fast-forward if the remote moved. Never merges or prompts — failures notify once. */
  async autoPull(): Promise<void> {
    const st = this.status;
    if (this.autoPulling || lock.gitScmSyncing || !st?.upstream || st.merging) return;
    this.autoPulling = true;
    try {
      await this.git.run(['fetch', '--prune']);
      await this.refresh();
      const behind = this.status?.behind ?? 0;
      if (!behind) return;
      await this.git.run(['pull', '--ff-only']);
      this.autoPullError = '';
      new Notice(t('Pulled {n} commit(s) from {upstream}', { n: behind, upstream: st.upstream }));
    } catch (e) {
      const msg = e instanceof GitError ? e.message : String(e);
      console.error('git auto-pull', e);
      // ponytail: dedupe by message only; a minute-by-minute retry stays silent until the error changes.
      const overlap = /would be overwritten|not possible to fast-forward|diverg/i.test(msg);
      if (msg !== this.autoPullError) new Notice(overlap ? t('New changes on the server touch files you are editing. Press Sync to combine them.') : t('Auto-pull failed:\n{msg}', { msg }), 10_000);
      this.autoPullError = msg;
    } finally {
      this.autoPulling = false;
      await this.refresh(true);
    }
  }

  manageRemotes(): void {
    if (this.isRepo) new RemotesModal(this.app, this).open(); else new Notice(t('Not a git repository'));
  }

  async push(): Promise<void> {
    if (!this.status) return;
    const st = this.status;
    if (!(await this.git.remotes()).length) {
      new Notice(t('No remote configured. Add one first.'));
      this.manageRemotes();
      return;
    }
    if (!st.upstream && st.branch && !(await confirm(this.app, t('Publish branch'), t("The branch '{branch}' has no remote branch. Publish it?", { branch: st.branch }), t('Publish')))) return;
    await this.run(t('Push'), () => this.git.push(st));
  }

  /**
   * One-button sync for people who don't know git: save (commit) everything, merge what others
   * pushed, push. Overlapping edits open the conflict view; resolving the last one calls sync again.
   * Returns true when local changes were committed (the caller clears its message box).
   */
  get syncing(): boolean { return !!lock.gitScmSyncing; }

  async sync(message = ''): Promise<boolean> {
    if (lock.gitScmSyncing) return false; // double click / another copy already syncing
    lock.gitScmSyncing = true;
    this.app.workspace.trigger(REFRESH_EVENT); // show "Syncing…"
    try { return await this.doSync(message); } finally {
      lock.gitScmSyncing = false;
      this.app.workspace.trigger(REFRESH_EVENT);
    }
  }

  private async doSync(message: string): Promise<boolean> {
    await this.refresh();
    const st = this.status;
    if (!st) return false;
    if (!(await this.git.remotes()).length) {
      new Notice(t('No remote configured. Add one first.'));
      this.manageRemotes();
      return false;
    }
    if (await this.openConflicts()) return false;
    let committed = false, conflicted = false;
    const ok = await this.run(t('Sync'), async () => {
      if (st.merging) await this.git.run(['commit', '--no-edit']); // all conflicts resolved: finish the merge
      else if (st.entries.length) {
        await this.git.addAll();
        await this.git.commit(message || await this.autoMessage());
        committed = true;
      }
      if (st.upstream) {
        // Merge, never rebase: conflict sides stay "mine" (HEAD) vs "theirs". --ff beats pull.ff=only.
        try { await this.git.run(['pull', '--no-rebase', '--ff', '--no-edit']); } catch (e) {
          if ((await this.git.status()).entries.some(x => x.conflict)) { conflicted = true; return; }
          throw e;
        }
      }
      await this.git.push(await this.git.status());
    }, true);
    if (conflicted) await this.openConflicts();
    else if (ok) new Notice(t('Synced'));
    return committed;
  }

  /** Open the resolver on the first conflicted file; true if there was one. */
  private async openConflicts(): Promise<boolean> {
    await this.refresh();
    const conflicts = this.status?.entries.filter(e => e.conflict) ?? [];
    if (!conflicts.length) return false;
    new Notice(t('Someone else changed the same places. Choose which version to keep ({n} file(s)).', { n: conflicts.length }), 10_000);
    await this.openView(CONFLICT_VIEW, 'tab', { path: conflicts[0].path });
    return true;
  }

  private async autoMessage(): Promise<string> {
    const name = this.settings.authorName || await this.git.config('user.name') || os.userInfo().username;
    return t('Changes by {name}, {date}', { name, date: new Date().toLocaleString() });
  }

  async switchBranch(): Promise<void> {
    if (!this.status) return;
    const branches = await this.git.branches();
    new BranchModal(this.app, branches, async item => {
      if ('create' in item) {
        const name = await prompt(this.app, t('New branch name'), 'feature/…');
        if (name?.trim()) await this.run(t('Create branch'), () => this.git.createBranch(name.trim()));
        return;
      }
      if (item.current) return;
      // A remote branch whose local counterpart exists: just switch to the local one.
      const local = item.remote ? branches.find(b => !b.remote && b.name === item.name.replace(/^[^/]+\//, '')) : undefined;
      await this.run(t('Checkout'), () => this.git.checkout(local ?? item));
    }).open();
  }

  async mergeBranch(): Promise<void> {
    const st = this.status;
    if (!st) return;
    if (st.merging) { new Notice(t('A merge is already in progress')); return; }
    if (!st.branch) { new Notice(t('Checkout a branch first (detached HEAD)')); return; }
    if (st.entries.some(e => !e.conflict && e.state !== '?')) { new Notice(t('Commit or discard local changes before merging')); return; }
    const branches = await this.git.branches();
    new BranchModal(this.app, branches, async item => {
      if ('create' in item) return;
      const ok = await this.run(t('Merge {name}', { name: item.name }), () => this.git.merge(item.name));
      if (ok && this.status?.merging) await this.openView(SCM_VIEW, 'left');
    }, 'merge').open();
  }

  async initRepo(): Promise<void> {
    if (this.isRepo) { new Notice(t('Already a git repository')); return; }
    const ok = await this.run(t('Initialize repository'), () => this.git.init());
    if (!ok) return;
    await this.ensureIdentity();
    const ignore = path.join(this.vaultPath, '.gitignore');
    if (!fs.existsSync(ignore) && await confirm(this.app, t('Create .gitignore'), t('Ignore Obsidian app data (.obsidian/, .trash) and track note content only?'), t('Create'))) {
      fs.writeFileSync(ignore, GITIGNORE);
    }
    await this.refresh();
    await this.openView(SCM_VIEW, 'left');
  }

  /** First-time git users have no identity and every commit would fail. Ask once, store globally. */
  async ensureIdentity(): Promise<void> {
    const fields: [string, string, string][] = [
      ['user.name', t('Your name (shown as the author of your commits)'), 'Jane Doe'],
      ['user.email', t('Your email (shown as the author of your commits)'), 'jane@example.com']
    ];
    for (const [key, title, placeholder] of fields) {
      if (await this.git.config(key)) continue;
      const v = (await prompt(this.app, title, placeholder))?.trim();
      if (v) await this.run(t('Set {key}', { key }), () => this.git.run(['config', '--global', key, v]), true);
    }
  }

  private async offerInit(): Promise<void> {
    if (await confirm(this.app, 'Git', t('This vault is not a git repository. Initialize one?'), t('Initialize repository'))) await this.initRepo();
  }

  async openView(type: string, where: 'left' | 'tab', state?: Record<string, unknown>): Promise<void> {
    // One leaf per view type: diffs and conflict resolvers reuse their tab like VS Code's preview editor.
    const leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(type)[0]
      ?? (where === 'left' ? this.app.workspace.getLeftLeaf(false) : this.app.workspace.getLeaf('tab'));
    if (!leaf) return;
    await leaf.setViewState({ type, active: true, state });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Open a vault file in the editor; files hidden from the vault (e.g. .obsidian/*) get a notice. */
  async openFile(filePath: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(filePath);
    if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f);
    else new Notice(t("Cannot open '{path}' in Obsidian", { path: filePath }));
  }
}

class GitSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GitPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl: el, plugin } = this;
    el.empty();
    const save = async () => { await plugin.saveData(plugin.settings); plugin.makeGit(); await plugin.refresh(); };
    new Setting(el).setName(t('Git executable')).setDesc(t('Leave empty to use `git` from PATH.'))
      .addText(x => x.setPlaceholder('git').setValue(plugin.settings.gitPath).onChange(v => { plugin.settings.gitPath = v.trim(); void save(); }));
    new Setting(el).setName(t('Additional PATH entries')).setDesc(t('Directories to prepend to PATH (macOS GUI apps do not see Homebrew). Separate with ":".'))
      .addText(x => x.setValue(plugin.settings.extraPath).onChange(v => { plugin.settings.extraPath = v.trim(); void save(); }));
    new Setting(el).setName(t('Author name')).setDesc(t('Overrides git config user.name for this vault. Leave empty to use the global config.'))
      .addText(x => x.setValue(plugin.settings.authorName).onChange(v => { plugin.settings.authorName = v.trim(); void save(); }));
    new Setting(el).setName(t('Author email'))
      .addText(x => x.setValue(plugin.settings.authorEmail).onChange(v => { plugin.settings.authorEmail = v.trim(); void save(); }));
  }
}
