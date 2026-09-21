import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon, type ViewStateResult } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type GitPlugin from './main';
import { REFRESH_EVENT } from './main';
import { applyResolution, hasConflictMarkers, parseConflicts, resolve, serialize, type Resolution } from './conflicts';

export const CONFLICT_VIEW = 'git-conflict';

/**
 * VS Code merge-conflict style resolver: each block shows the current (HEAD) and
 * incoming sides with Accept current / incoming / both. Saves the file after each choice;
 * once no markers remain, "Mark as resolved" stages it.
 */
export class ConflictView extends ItemView {
  private path = '';
  constructor(leaf: WorkspaceLeaf, private plugin: GitPlugin) { super(leaf); }
  getViewType(): string { return CONFLICT_VIEW; }
  getDisplayText(): string { return `Resolve: ${this.path.split('/').pop() ?? ''}`; }
  getIcon(): string { return 'git-merge'; }
  getState(): Record<string, unknown> { return { path: this.path }; }
  async setState(state: { path: string }, result: ViewStateResult): Promise<void> {
    this.path = state.path ?? this.path;
    await super.setState(state, result);
    await this.render();
  }
  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on(REFRESH_EVENT as 'quit', () => void this.render()));
  }

  private abs(): string { return path.join(this.plugin.vaultPath, this.path); }
  private read(): string { return fs.readFileSync(this.abs(), 'utf8'); }
  private async write(text: string): Promise<void> {
    // Prefer the Vault API so open editors and the index update; fall back for hidden files.
    const f = this.app.vault.getAbstractFileByPath(this.path);
    if (f instanceof TFile) await this.app.vault.modify(f, text); else fs.writeFileSync(this.abs(), text);
  }

  private async render(): Promise<void> {
    if (!this.path) return;
    const el = this.contentEl;
    el.empty();
    el.addClass('git-conflict');
    const bar = el.createDiv({ cls: 'git-diff-toolbar' });
    bar.createSpan({ text: this.path, cls: 'git-diff-path' });
    const btn = (text: string, cb: () => unknown, cta = false) => { const b = bar.createEl('button', { text, cls: cta ? 'mod-cta' : '' }); b.onclick = () => void cb(); return b; };
    if (!fs.existsSync(this.abs())) {
      el.createDiv({ cls: 'git-empty', text: 'File does not exist in the working tree (deleted on one side).' });
      btn('Keep deleted (git rm)', () => this.plugin.run('Resolve', () => this.plugin.git.run(['rm', '--', this.path])).then(() => this.leaf.detach()));
      return;
    }
    let text: string;
    try { text = this.read(); } catch (e) { el.createDiv({ cls: 'git-empty', text: (e as Error).message }); return; }
    const entry = this.plugin.status?.entries.find(e => e.path === this.path && e.conflict);
    const blocks = parseConflicts(text);
    const conflicts = blocks.filter(b => b.kind === 'conflict').length;
    btn('Open in editor', () => this.plugin.openFile(this.path));
    if (conflicts) {
      btn('Accept all current', () => this.acceptAll('current'));
      btn('Accept all incoming', () => this.acceptAll('incoming'));
      bar.createSpan({ text: `${conflicts} conflict(s)`, cls: 'git-count' });
    } else {
      bar.createSpan({ text: entry ? 'No conflict markers left.' : hasConflictMarkers(text) ? '' : 'Resolved and staged.', cls: 'git-count' });
      if (entry) btn('Mark as resolved (stage)', () => this.plugin.run('Stage', () => this.plugin.git.add([this.path])).then(() => this.leaf.detach()), true);
    }

    const body = el.createDiv({ cls: 'git-conflict-body' });
    let n = 0;
    for (const b of blocks) {
      if (b.kind === 'text') { for (const l of b.lines) body.createDiv({ cls: 'git-conflict-line', text: l || ' ' }); continue; }
      const idx = n++;
      const box = body.createDiv({ cls: 'git-conflict-block' });
      const head = box.createDiv({ cls: 'git-conflict-head git-conflict-current-head' });
      head.createSpan({ text: `<<<<<<< ${b.currentHeader} (Current change)` });
      const acts = head.createSpan({ cls: 'git-conflict-actions' });
      const act = (label: string, how: Resolution) => { const a = acts.createSpan({ text: label, cls: 'git-conflict-action' }); a.onclick = () => void this.accept(idx, how); };
      act('Accept current change', 'current'); act('Accept incoming change', 'incoming'); act('Accept both changes', 'both');
      for (const l of b.current) box.createDiv({ cls: 'git-conflict-line git-conflict-current', text: l || ' ' });
      if (b.base) {
        box.createDiv({ cls: 'git-conflict-head git-conflict-base-head', text: '||||||| (Common ancestor)' });
        for (const l of b.base) box.createDiv({ cls: 'git-conflict-line git-conflict-base', text: l || ' ' });
      }
      box.createDiv({ cls: 'git-conflict-sep', text: '=======' });
      for (const l of b.incoming) box.createDiv({ cls: 'git-conflict-line git-conflict-incoming', text: l || ' ' });
      box.createDiv({ cls: 'git-conflict-head git-conflict-incoming-head', text: `>>>>>>> ${b.incomingHeader} (Incoming change)` });
    }
  }

  private async accept(index: number, how: Resolution): Promise<void> {
    await this.write(applyResolution(this.read(), index, how));
    await this.render();
  }

  private async acceptAll(how: Resolution): Promise<void> {
    const blocks = parseConflicts(this.read()).map(b => b.kind === 'conflict' ? { kind: 'text' as const, lines: resolve(b, how) } : b);
    await this.write(serialize(blocks));
    new Notice(`Accepted all ${how} changes`);
    await this.render();
  }
}
