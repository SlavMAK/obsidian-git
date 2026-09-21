import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon, type ViewStateResult } from 'obsidian';
import type GitPlugin from './main';
import { REFRESH_EVENT } from './main';
import type { StatusEntry } from './git';
import { confirm } from './ui';
import { GRAPH_VIEW } from './graph-view';
import { CONFLICT_VIEW } from './conflict-view';
import { t } from './i18n';

export const SCM_VIEW = 'git-scm';
export const DIFF_VIEW = 'git-diff';

/** VS Code style letter for the badge: untracked shows U, conflicts show !. */
const badge = (e: StatusEntry): string => e.conflict ? '!' : e.state === '?' ? 'U' : e.state;
const badgeTitle: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Untracked', '!': 'Conflict' };

export class ScmView extends ItemView {
  private message = '';
  private collapsed = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private plugin: GitPlugin) { super(leaf); }
  getViewType(): string { return SCM_VIEW; }
  getDisplayText(): string { return t('Source control'); }
  getIcon(): string { return 'git-pull-request'; }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on(REFRESH_EVENT as 'quit', () => this.render()));
    this.render();
  }

  private render(): void {
    const { plugin } = this;
    const root = this.contentEl;
    // A background refresh must not steal the caret from a half-typed commit message.
    const active = root.ownerDocument.activeElement as HTMLTextAreaElement | null;
    const caret = active?.hasClass('git-message') && root.contains(active) ? active.selectionStart : -1;
    root.empty();
    root.addClass('git-scm');
    if (!plugin.isRepo) {
      const empty = root.createDiv({ cls: 'git-empty' });
      empty.createEl('p', { text: plugin.lastError ?? t('This vault is not a git repository.') });
      empty.createEl('button', { text: t('Initialize repository'), cls: 'mod-cta' }).onclick = () => void plugin.initRepo();
      return;
    }
    const st = plugin.status;
    if (!st) {
      root.createDiv({ cls: 'git-empty' }).createEl('p', { text: plugin.lastError ?? t('Loading…') });
      return;
    }

    // Header: branch + ahead/behind + toolbar
    const header = root.createDiv({ cls: 'git-header' });
    const branch = header.createDiv({ cls: 'git-branch mod-clickable', attr: { 'aria-label': t('Switch branch') } });
    setIcon(branch.createSpan(), 'git-branch');
    branch.createSpan({ text: st.branch ?? t('detached @ {head}', { head: st.head }) });
    if (st.ahead || st.behind) branch.createSpan({ cls: 'git-ab', text: `${st.ahead ? `↑${st.ahead}` : ''} ${st.behind ? `↓${st.behind}` : ''}`.trim() });
    branch.onclick = () => void plugin.switchBranch();
    const tools = header.createDiv({ cls: 'git-tools' });
    const tool = (icon: string, label: string, cb: () => unknown) => {
      const b = tools.createSpan({ cls: 'clickable-icon', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.onclick = () => void cb();
    };
    tool('refresh-cw', t('Refresh'), () => plugin.refresh(true));
    tool('cloud-download', t('Fetch'), () => plugin.run(t('Fetch'), () => plugin.git.fetch()));
    tool('download', t('Pull'), () => plugin.run(t('Pull'), () => plugin.git.pull()));
    tool('upload', t(st.upstream ? 'Push' : 'Publish branch'), () => plugin.push());
    tool('git-graph', t('Commit graph'), () => plugin.openView(GRAPH_VIEW, 'tab'));
    tool('git-merge', t('Merge branch into current'), () => plugin.mergeBranch());
    tool('server', t('Manage remotes'), () => plugin.manageRemotes());

    // Commit box
    const staged = st.entries.filter(e => e.staged);
    const changes = st.entries.filter(e => !e.staged && !e.conflict);
    const conflicts = st.entries.filter(e => e.conflict);
    const box = root.createDiv({ cls: 'git-commit-box' });
    const ta = box.createEl('textarea', { cls: 'git-message', attr: { rows: '3', placeholder: t("Message (Ctrl+Enter to commit on '{branch}')", { branch: st.branch ?? 'HEAD' }) } });
    ta.value = this.message;
    if (caret >= 0) { ta.focus(); ta.setSelectionRange(caret, caret); }
    ta.oninput = () => { this.message = ta.value; };
    ta.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void this.commit(); } };
    const row = box.createDiv({ cls: 'git-commit-row' });
    const commitBtn = row.createEl('button', { text: t('Commit'), cls: 'mod-cta git-commit-btn' });
    commitBtn.onclick = () => void this.commit();
    if (st.merging) commitBtn.setText(t('Commit merge'));
    const more = row.createEl('button', { cls: 'git-commit-more', attr: { 'aria-label': t('More commit actions') } });
    setIcon(more, 'chevron-down');
    more.onclick = ev => {
      const menu = new Menu();
      menu.addItem(i => i.setTitle(t('Commit (amend)')).setIcon('pencil').onClick(() => void this.commit({ amend: true })));
      menu.addItem(i => i.setTitle(t('Commit & push')).setIcon('upload').onClick(() => void this.commit({ push: true })));
      menu.addItem(i => i.setTitle(t('Stage all & commit')).setIcon('plus-circle').onClick(() => void this.commit({ all: true })));
      menu.addItem(i => i.setTitle(t('Stage all, commit & push')).setIcon('arrow-up-circle').onClick(() => void this.commit({ all: true, push: true })));
      menu.addSeparator();
      menu.addItem(i => i.setTitle(t('Undo last commit')).setIcon('undo-2').setDisabled(st.head === '(initial)').onClick(() => void this.undoLastCommit()));
      menu.showAtMouseEvent(ev);
    };
    if (st.merging) {
      const banner = root.createDiv({ cls: 'git-banner' });
      banner.createSpan({ text: conflicts.length ? t('Merge in progress: resolve {n} conflict(s), then commit.', { n: conflicts.length }) : t('Merge in progress: all conflicts resolved, commit to finish.') });
      const abort = banner.createEl('button', { text: t('Abort merge'), cls: 'mod-warning' });
      abort.onclick = async () => {
        if (await confirm(this.app, t('Abort merge'), t('Discard the merge and restore the pre-merge state?'), t('Abort merge'), true)) await plugin.run(t('Abort merge'), () => plugin.git.mergeAbort());
      };
    }

    // Groups
    if (conflicts.length) this.group(root, t('Merge changes'), conflicts, [
      { icon: 'check', label: t('Mark as resolved (stage)'), cb: e => this.stage([e]) }
    ], e => plugin.openView(CONFLICT_VIEW, 'tab', { path: e.path }), [
      { icon: 'check-check', label: t('Stage all resolved'), cb: () => this.stage(conflicts) }
    ]);
    this.group(root, t('Staged changes'), staged, [
      { icon: 'minus', label: t('Unstage'), cb: e => plugin.run(t('Unstage'), () => plugin.git.unstage([e.path]), true) }
    ], e => this.openDiff(e), [
      { icon: 'minus', label: t('Unstage all'), cb: () => plugin.run(t('Unstage all'), () => plugin.git.unstageAll(), true) }
    ]);
    this.group(root, t('Changes'), changes, [
      { icon: 'undo-2', label: t('Discard changes'), cb: e => this.discard([e]) },
      { icon: 'plus', label: t('Stage'), cb: e => this.stage([e]) }
    ], e => this.openDiff(e), [
      { icon: 'undo-2', label: t('Discard all changes'), cb: () => this.discard(changes) },
      { icon: 'plus', label: t('Stage all'), cb: () => this.stage(changes) }
    ]);
    if (!st.entries.length) root.createDiv({ cls: 'git-empty', text: t('No changes') });
  }

  private group(root: HTMLElement, title: string, entries: StatusEntry[], actions: { icon: string; label: string; cb: (e: StatusEntry) => unknown }[],
    onClick: (e: StatusEntry) => unknown, groupActions: { icon: string; label: string; cb: () => unknown }[]): void {
    if (!entries.length) return;
    const sec = root.createDiv({ cls: 'git-group' });
    const head = sec.createDiv({ cls: 'git-group-header' });
    const chevron = head.createSpan({ cls: 'git-chevron' });
    setIcon(chevron, this.collapsed.has(title) ? 'chevron-right' : 'chevron-down');
    head.createSpan({ text: title, cls: 'git-group-title' });
    head.createSpan({ text: String(entries.length), cls: 'git-count' });
    const gt = head.createSpan({ cls: 'git-row-actions' });
    for (const a of groupActions) {
      const b = gt.createSpan({ cls: 'clickable-icon', attr: { 'aria-label': a.label } });
      setIcon(b, a.icon);
      b.onclick = ev => { ev.stopPropagation(); void a.cb(); };
    }
    head.onclick = () => { this.collapsed.has(title) ? this.collapsed.delete(title) : this.collapsed.add(title); this.render(); };
    if (this.collapsed.has(title)) return;
    const list = sec.createDiv({ cls: 'git-list' });
    for (const e of entries) {
      const row = list.createDiv({ cls: 'git-file', attr: { 'aria-label': `${badgeTitle[badge(e)] ?? ''} ${e.from ? `${e.from} → ` : ''}${e.path}` } });
      const name = e.path.split('/').pop() ?? e.path;
      const dir = e.path.slice(0, e.path.length - name.length).replace(/\/$/, '');
      row.createSpan({ text: name, cls: `git-file-name git-state-${badge(e).replace('!', 'conflict').replace('?', 'U')}` });
      if (dir) row.createSpan({ text: dir, cls: 'git-file-dir' });
      const acts = row.createSpan({ cls: 'git-row-actions' });
      const open = acts.createSpan({ cls: 'clickable-icon', attr: { 'aria-label': t('Open file') } });
      setIcon(open, 'file');
      open.onclick = ev => { ev.stopPropagation(); void this.plugin.openFile(e.path); };
      for (const a of actions) {
        const b = acts.createSpan({ cls: 'clickable-icon', attr: { 'aria-label': a.label } });
        setIcon(b, a.icon);
        b.onclick = ev => { ev.stopPropagation(); void a.cb(e); };
      }
      row.createSpan({ text: badge(e), cls: `git-badge-letter git-state-${badge(e).replace('!', 'conflict')}` });
      row.onclick = () => void onClick(e);
    }
  }

  private stage(entries: StatusEntry[]): Promise<boolean> {
    return this.plugin.run(t('Stage'), () => this.plugin.git.add(entries.map(e => e.path)), true);
  }

  private async discard(entries: StatusEntry[]): Promise<void> {
    const untracked = entries.filter(e => e.state === '?').length;
    const what = entries.length === 1 ? t("changes in '{path}'", { path: entries[0].path }) : t('changes in {n} files', { n: entries.length });
    const extra = untracked ? t(' {n} untracked file(s) will be DELETED.', { n: untracked }) : '';
    if (!(await confirm(this.app, t('Discard changes'), t('Are you sure you want to discard {what}? This cannot be undone.{extra}', { what, extra }), t('Discard changes'), true))) return;
    await this.plugin.run(t('Discard'), () => this.plugin.git.discard(entries), true);
  }

  private async commit(opts: { amend?: boolean; push?: boolean; all?: boolean } = {}): Promise<void> {
    const { plugin } = this;
    const st = plugin.status;
    if (!st) return;
    if (st.entries.some(e => e.conflict)) { new Notice(t('Resolve conflicts before committing')); return; }
    const hasStaged = st.entries.some(e => e.staged);
    let all = opts.all;
    if (!hasStaged && !all && !opts.amend) {
      if (!st.entries.length) { new Notice(t('No changes to commit')); return; }
      // VS Code "smart commit": offer to stage everything.
      if (!(await confirm(this.app, t('Commit'), t('There are no staged changes to commit. Stage all your changes and commit them directly?'), t('Stage all & commit')))) return;
      all = true;
    }
    let message = this.message.trim();
    if (!message && !opts.amend) { new Notice(t('Enter a commit message')); return; }
    if (!message && opts.amend) message = (await plugin.git.run(['log', '-1', '--format=%B'])).trim();
    if (all) { if (!(await plugin.run(t('Stage all'), () => plugin.git.addAll(), true))) return; }
    const ok = await plugin.run(t('Commit'), () => plugin.git.commit(message, opts.amend));
    if (!ok) return;
    this.message = '';
    if (opts.push) await plugin.push(); else this.render();
  }

  async undoLastCommit(): Promise<void> {
    const { plugin } = this;
    const st = plugin.status;
    if (!st || st.head === '(initial)') { new Notice(t('Nothing to undo')); return; }
    if (st.merging) { new Notice(t('Finish or abort the merge first')); return; }
    if (st.upstream && st.ahead === 0 && !(await confirm(this.app, t('Undo last commit'),
      t('The last commit is already pushed. Undoing it locally will make this branch diverge from the remote. Continue?'), t('Undo anyway'), true))) return;
    let message = '';
    const ok = await plugin.run(t('Undo last commit'), async () => { message = await plugin.git.undoLastCommit(); return t('changes kept staged'); });
    if (ok) { this.message = message; this.render(); }
  }

  private openDiff(e: StatusEntry): Promise<void> {
    return this.plugin.openView(DIFF_VIEW, 'tab', { path: e.path, staged: e.staged, untracked: e.state === '?' });
  }
}

interface DiffState { path: string; staged: boolean; untracked: boolean }

/** Unified diff of one file (working tree vs index, or index vs HEAD). */
export class DiffView extends ItemView {
  private state: DiffState = { path: '', staged: false, untracked: false };
  constructor(leaf: WorkspaceLeaf, private plugin: GitPlugin) { super(leaf); }
  getViewType(): string { return DIFF_VIEW; }
  getDisplayText(): string { return `${this.state.path.split('/').pop() ?? ''} (${t(this.state.staged ? 'staged' : 'working tree')})`; }
  getIcon(): string { return 'diff'; }
  getState(): Record<string, unknown> { return { ...this.state }; }
  async setState(state: DiffState, result: ViewStateResult): Promise<void> {
    this.state = { ...this.state, ...state };
    await super.setState(state, result);
    await this.render();
  }
  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on(REFRESH_EVENT as 'quit', () => void this.render()));
  }
  private async render(): Promise<void> {
    const { path, staged, untracked } = this.state;
    if (!path) return;
    const el = this.contentEl;
    el.empty();
    el.addClass('git-diff');
    const toolbar = el.createDiv({ cls: 'git-diff-toolbar' });
    toolbar.createSpan({ text: path, cls: 'git-diff-path' });
    const open = toolbar.createEl('button', { text: t('Open file') });
    open.onclick = () => void this.plugin.openFile(path);
    const act = toolbar.createEl('button', { text: t(staged ? 'Unstage' : 'Stage'), cls: 'mod-cta' });
    act.onclick = () => void this.plugin.run(staged ? 'Unstage' : 'Stage', () => staged ? this.plugin.git.unstage([path]) : this.plugin.git.add([path]), true)
      .then(() => { this.state.staged = !staged; void this.render(); });
    let diff = '';
    try { diff = untracked && !staged ? await this.plugin.git.diffUntracked(path) : await this.plugin.git.diff(path, staged); }
    catch (e) { el.createDiv({ cls: 'git-empty', text: (e as Error).message }); return; }
    if (!diff.trim()) { el.createDiv({ cls: 'git-empty', text: t('No differences') }); return; }
    const pre = el.createDiv({ cls: 'git-diff-body' });
    for (const line of diff.replace(/\n$/, '').split('\n')) {
      const cls = line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('@@') ? 'hunk'
        : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : /^(diff|index|new file|deleted file|similarity|rename|Binary)/.test(line) ? 'meta' : 'ctx';
      pre.createDiv({ cls: `git-diff-line git-diff-${cls}`, text: line || ' ' });
    }
  }
}
