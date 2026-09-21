import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, debounce } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { Git, GitError, type Status } from './git';
import { BranchModal, RemotesModal, confirm, prompt } from './ui';
import { SCM_VIEW, ScmView, DIFF_VIEW, DiffView } from './scm-view';
import { GRAPH_VIEW, GraphView } from './graph-view';
import { CONFLICT_VIEW, ConflictView } from './conflict-view';

interface Settings {
  gitPath: string;
  extraPath: string;
  authorName: string;
  authorEmail: string;
}
const DEFAULTS: Settings = { gitPath: '', extraPath: '', authorName: '', authorEmail: '' };

export const REFRESH_EVENT = 'git-scm:refresh';
const GITIGNORE = `# Obsidian app data: settings, layout, plugins, themes, caches.
# Per-device state that conflicts between machines — the vault syncs content only.
.obsidian/
.trash/

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
    if (!(adapter instanceof FileSystemAdapter)) { new Notice('Git: desktop only'); return; }
    this.vaultPath = adapter.getBasePath();
    this.makeGit();

    this.registerView(SCM_VIEW, leaf => new ScmView(leaf, this));
    this.registerView(DIFF_VIEW, leaf => new DiffView(leaf, this));
    this.registerView(GRAPH_VIEW, leaf => new GraphView(leaf, this));
    this.registerView(CONFLICT_VIEW, leaf => new ConflictView(leaf, this));
    this.addRibbonIcon('git-pull-request', 'Open Git source control', () => void this.openView(SCM_VIEW, 'left'));
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass('mod-clickable');
    this.statusBar.onClickEvent(() => void this.switchBranch());

    const cmd = (id: string, name: string, cb: () => unknown) => this.addCommand({ id, name, callback: () => void cb() });
    cmd('open-source-control', 'Open source control', () => this.openView(SCM_VIEW, 'left'));
    cmd('open-graph', 'Open commit graph', () => this.openView(GRAPH_VIEW, 'tab'));
    cmd('init', 'Initialize repository', () => this.initRepo());
    cmd('commit', 'Commit staged changes', () => this.openView(SCM_VIEW, 'left'));
    cmd('push', 'Push', () => this.push());
    cmd('pull', 'Pull', () => this.run('Pull', () => this.git.pull()));
    cmd('fetch', 'Fetch', () => this.run('Fetch', () => this.git.fetch()));
    cmd('switch-branch', 'Switch branch', () => this.switchBranch());
    cmd('remotes', 'Manage remotes', () => this.manageRemotes());
    cmd('merge', 'Merge branch into current', () => this.mergeBranch());
    cmd('undo-commit', 'Undo last commit', async () => { await this.openView(SCM_VIEW, 'left'); await (this.app.workspace.getLeavesOfType(SCM_VIEW)[0]?.view as ScmView | undefined)?.undoLastCommit(); });
    cmd('stage-all', 'Stage all changes', () => this.run('Stage all', () => this.git.addAll()));
    cmd('refresh', 'Refresh status', () => this.refresh(true));
    this.addSettingTab(new GitSettingTab(this.app, this));

    const onChange = () => this.refreshDebounced();
    this.registerEvent(this.app.vault.on('create', onChange));
    this.registerEvent(this.app.vault.on('modify', onChange));
    this.registerEvent(this.app.vault.on('delete', onChange));
    this.registerEvent(this.app.vault.on('rename', onChange));
    // .git itself is outside the vault's watcher (external pushes, CLI commits), so poll lightly too.
    this.registerInterval(window.setInterval(() => void this.refresh(), 30_000));

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
      this.statusBar.setText(`${st.branch ?? st.head}${ab}${st.merging ? ' (merging)' : ''}`);
      this.statusBar.setAttribute('aria-label', 'Git: switch branch');
    }
    this.app.workspace.trigger(REFRESH_EVENT);
  }

  /** Run a git action with a notice on failure, then refresh. */
  async run(label: string, fn: () => Promise<string | void>, quiet = false): Promise<boolean> {
    try {
      const out = await fn();
      if (!quiet) new Notice(`${label}: ${(out ?? '').trim().split('\n').filter(Boolean).pop() || 'done'}`);
      return true;
    } catch (e) {
      const msg = e instanceof GitError ? e.message : String(e);
      if (/tell me who you are|Author identity unknown/i.test(msg)) new Notice('Git: set author name and email in the plugin settings', 8000);
      new Notice(`${label} failed:\n${msg}`, 10_000);
      console.error(`git ${label}`, e);
      return false;
    } finally {
      await this.refresh(true);
    }
  }

  manageRemotes(): void {
    if (this.isRepo) new RemotesModal(this.app, this).open(); else new Notice('Not a git repository');
  }

  async push(): Promise<void> {
    if (!this.status) return;
    const st = this.status;
    if (!(await this.git.remotes()).length) {
      new Notice('No remote configured. Add one first.');
      this.manageRemotes();
      return;
    }
    if (!st.upstream && st.branch && !(await confirm(this.app, 'Publish branch', `The branch '${st.branch}' has no remote branch. Publish it?`, 'Publish'))) return;
    await this.run('Push', () => this.git.push(st));
  }

  async switchBranch(): Promise<void> {
    if (!this.status) return;
    const branches = await this.git.branches();
    new BranchModal(this.app, branches, async item => {
      if ('create' in item) {
        const name = await prompt(this.app, 'New branch name', 'feature/…');
        if (name?.trim()) await this.run('Create branch', () => this.git.createBranch(name.trim()));
        return;
      }
      if (item.current) return;
      // A remote branch whose local counterpart exists: just switch to the local one.
      const local = item.remote ? branches.find(b => !b.remote && b.name === item.name.replace(/^[^/]+\//, '')) : undefined;
      await this.run('Checkout', () => this.git.checkout(local ?? item));
    }).open();
  }

  async mergeBranch(): Promise<void> {
    const st = this.status;
    if (!st) return;
    if (st.merging) { new Notice('A merge is already in progress'); return; }
    if (!st.branch) { new Notice('Checkout a branch first (detached HEAD)'); return; }
    if (st.entries.some(e => !e.conflict && e.state !== '?')) { new Notice('Commit or discard local changes before merging'); return; }
    const branches = await this.git.branches();
    new BranchModal(this.app, branches, async item => {
      if ('create' in item) return;
      const ok = await this.run(`Merge ${item.name}`, () => this.git.merge(item.name));
      if (ok && this.status?.merging) await this.openView(SCM_VIEW, 'left');
    }, 'merge').open();
  }

  async initRepo(): Promise<void> {
    if (this.isRepo) { new Notice('Already a git repository'); return; }
    const ok = await this.run('Initialize repository', () => this.git.init());
    if (!ok) return;
    const ignore = path.join(this.vaultPath, '.gitignore');
    if (!fs.existsSync(ignore) && await confirm(this.app, 'Create .gitignore', 'Ignore Obsidian app data (.obsidian/, .trash) and track note content only?', 'Create')) {
      fs.writeFileSync(ignore, GITIGNORE);
    }
    await this.refresh();
    await this.openView(SCM_VIEW, 'left');
  }

  private async offerInit(): Promise<void> {
    if (await confirm(this.app, 'Git', 'This vault is not a git repository. Initialize one?', 'Initialize repository')) await this.initRepo();
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
    else new Notice(`Cannot open '${filePath}' in Obsidian`);
  }
}

class GitSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GitPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl: el, plugin } = this;
    el.empty();
    const save = async () => { await plugin.saveData(plugin.settings); plugin.makeGit(); await plugin.refresh(); };
    new Setting(el).setName('Git executable').setDesc('Leave empty to use `git` from PATH.')
      .addText(t => t.setPlaceholder('git').setValue(plugin.settings.gitPath).onChange(v => { plugin.settings.gitPath = v.trim(); void save(); }));
    new Setting(el).setName('Additional PATH entries').setDesc('Directories to prepend to PATH (macOS GUI apps do not see Homebrew). Separate with ":".')
      .addText(t => t.setValue(plugin.settings.extraPath).onChange(v => { plugin.settings.extraPath = v.trim(); void save(); }));
    new Setting(el).setName('Author name').setDesc('Overrides git config user.name for this vault. Leave empty to use the global config.')
      .addText(t => t.setValue(plugin.settings.authorName).onChange(v => { plugin.settings.authorName = v.trim(); void save(); }));
    new Setting(el).setName('Author email')
      .addText(t => t.setValue(plugin.settings.authorEmail).onChange(v => { plugin.settings.authorEmail = v.trim(); void save(); }));
  }
}
