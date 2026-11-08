import { Component, ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, setIcon, type ViewStateResult } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type GitPlugin from './main';
import { REFRESH_EVENT } from './main';
import { applyResolution, hasConflictMarkers, parseConflicts, resolve, serialize, type Resolution, type Side } from './conflicts';
import { t } from './i18n';

export const CONFLICT_VIEW = 'git-conflict';

interface Choice { order: Side[]; on: Side[] }
const kept = (c: Choice): Side[] => c.order.filter(s => c.on.includes(s));

/**
 * Conflict resolver showing the resulting file as rendered markdown. In each conflict both pieces
 * (mine and incoming) are listed; switches decide what goes into the file, arrows set the order;
 * once no markers remain, "Mark as resolved" stages it.
 */
export class ConflictView extends ItemView {
  private path = '';
  private md?: Component;
  /** Per conflict: display order of both pieces and which of them go into the file. */
  private choices: Choice[] = [];
  constructor(leaf: WorkspaceLeaf, private plugin: GitPlugin) { super(leaf); }
  getViewType(): string { return CONFLICT_VIEW; }
  getDisplayText(): string { return t('Resolve: {name}', { name: this.path.split('/').pop() ?? '' }); }
  getIcon(): string { return 'git-merge'; }
  getState(): Record<string, unknown> { return { path: this.path }; }
  async setState(state: { path: string }, result: ViewStateResult): Promise<void> {
    if (state.path !== this.path) this.choices = [];
    this.path = state.path ?? this.path;
    await super.setState(state, result);
    await this.render();
  }
  async onOpen(): Promise<void> {
    // Status refreshes fire often; rebuilding re-renders all markdown and flickers, so only when something changed.
    this.registerEvent(this.app.workspace.on(REFRESH_EVENT as 'quit', () => void this.render(false)));
  }

  private abs(): string { return path.join(this.plugin.vaultPath, this.path); }
  private read(): string { return fs.readFileSync(this.abs(), 'utf8'); }
  private async write(text: string): Promise<void> {
    // Prefer the Vault API so open editors and the index update; fall back for hidden files.
    const f = this.app.vault.getAbstractFileByPath(this.path);
    if (f instanceof TFile) await this.app.vault.modify(f, text); else fs.writeFileSync(this.abs(), text);
  }

  private key = '';

  /** What the screen depends on: file text + this file's conflict state + whether it is the last one. */
  private stateKey(text: string): string {
    const st = this.plugin.status;
    return JSON.stringify([this.path, text, st?.merging, st?.entries.filter(e => e.conflict).map(e => e.path)]);
  }

  private async render(force = true): Promise<void> {
    if (!this.path) return;
    let current = '';
    try { current = this.read(); } catch { /* handled below */ }
    const key = this.stateKey(current);
    if (!force && key === this.key) return;
    this.key = key;
    const el = this.contentEl;
    const scroll = el.scrollTop; // accepting a block re-renders; don't jump back to the top
    el.empty();
    el.addClass('git-conflict');
    const bar = el.createDiv({ cls: 'git-diff-toolbar' });
    bar.createSpan({ text: this.path, cls: 'git-diff-path' });
    const btn = (text: string, cb: () => unknown, cta = false) => { const b = bar.createEl('button', { text, cls: cta ? 'mod-cta' : '' }); b.onclick = () => void cb(); return b; };
    if (!fs.existsSync(this.abs())) {
      el.createDiv({ cls: 'git-empty', text: t('File does not exist in the working tree (deleted on one side).') });
      btn(t('Keep deleted (git rm)'), () => this.plugin.run(t('Resolve'), () => this.plugin.git.run(['rm', '--', this.path])).then(() => this.leaf.detach()));
      return;
    }
    let text: string;
    try { text = this.read(); } catch (e) { el.createDiv({ cls: 'git-empty', text: (e as Error).message }); return; }
    const entry = this.plugin.status?.entries.find(e => e.path === this.path && e.conflict);
    const blocks = parseConflicts(text);
    const conflicts = blocks.filter(b => b.kind === 'conflict').length;
    btn(t('Open in editor'), () => this.plugin.openFile(this.path));
    if (conflicts) {
      btn(t('Apply all'), () => this.acceptAll(i => this.choices[i] ? kept(this.choices[i]) : 'current'), true);
      btn(t('Keep all mine'), () => this.acceptAll(() => 'current'));
      btn(t('Take all theirs'), () => this.acceptAll(() => 'incoming'));
      bar.createSpan({ text: t('{n} conflict(s)', { n: conflicts }), cls: 'git-count' });
    } else {
      bar.createSpan({ text: entry ? t('No conflict markers left.') : hasConflictMarkers(text) ? '' : t('Resolved and staged.'), cls: 'git-count' });
      // Last conflicted file of a merge: "Done" stages it and finishes the sync (merge commit + push).
      const last = !!entry && this.plugin.status?.merging && !this.plugin.status.entries.some(e => e.conflict && e.path !== this.path);
      if (entry) btn(last ? t('Done — sync') : t('Mark as resolved (stage)'), async () => {
        if (!(await this.plugin.run(t('Stage'), () => this.plugin.git.add([this.path]), true))) return;
        this.leaf.detach();
        if (last) await this.plugin.sync();
      }, true);
    }

    // One column = the resulting file. Each conflict shows both pieces; switches turn a piece on
    // (goes into the file) or off (faded), arrows reorder them. Content is rendered markdown.
    const first = blocks.find(b => b.kind === 'conflict');
    // `git pull` marks the incoming side with a commit hash: that's "the server" for the user.
    const fromServer = !!first && /^[0-9a-f]{7,40}$/.test(first.incomingHeader);
    const body = el.createDiv({ cls: 'git-conflict-body' });
    this.md?.unload();
    this.md = this.addChild(new Component());
    const renders: Promise<void>[] = [];
    const markdown = (parent: HTMLElement, lines: string[]) => renders.push(this.renderMd(parent, lines));
    const count = blocks.filter(b => b.kind === 'conflict').length;
    // file changed under us -> start over: both pieces listed, only mine switched on
    if (this.choices.length !== count) this.choices = Array.from({ length: count }, () => ({ order: ['current', 'incoming'], on: ['current'] }));
    let n = 0;
    for (const b of blocks) {
      if (b.kind === 'text') { markdown(body.createDiv({ cls: 'git-conflict-same' }), b.lines); continue; }
      const idx = n++;
      const choice = this.choices[idx];
      const slot = body.createDiv({ cls: 'git-conflict-slot' });
      // Everything below edits the DOM in place: re-rendering markdown on every click flickers.
      const items = {} as Record<Side, HTMLElement>;
      const arrows: { s: Side; up: HTMLElement; down: HTMLElement }[] = [];
      const syncArrows = () => arrows.forEach(a => {
        const i = choice.order.indexOf(a.s);
        a.up.toggleClass('is-disabled', i === 0);
        a.down.toggleClass('is-disabled', i === choice.order.length - 1);
      });
      for (const s of choice.order) {
        const item = items[s] = slot.createDiv({ cls: `git-conflict-piece git-conflict-${s}` });
        const head = item.createDiv({ cls: 'git-conflict-actions' });
        const sw = head.createDiv({ cls: 'checkbox-container', attr: { role: 'switch', tabindex: '0' } });
        sw.createEl('input', { type: 'checkbox', attr: { tabindex: '-1' } });
        const paint = () => {
          const on = choice.on.includes(s);
          item.toggleClass('is-off', !on);
          sw.toggleClass('is-enabled', on);
          sw.setAttr('aria-checked', String(on));
        };
        const flip = () => { choice.on = choice.on.includes(s) ? choice.on.filter(x => x !== s) : [...choice.on, s]; paint(); };
        paint();
        sw.onclick = flip;
        sw.onkeydown = e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } };
        head.createSpan({ cls: 'git-conflict-piece-label', text: s === 'current' ? t('Mine') : fromServer ? t('From the server') : t('Incoming') });
        const move = (icon: string, aria: string, delta: number) => {
          const m = head.createSpan({ cls: 'clickable-icon', attr: { 'aria-label': aria } });
          setIcon(m, icon);
          m.onclick = () => {
            const i = choice.order.indexOf(s), to = i + delta;
            if (to < 0 || to >= choice.order.length) return;
            [choice.order[i], choice.order[to]] = [choice.order[to], choice.order[i]];
            for (const x of choice.order) slot.insertBefore(items[x], applyRow); // move nodes, no re-render
            syncArrows();
          };
          return m;
        };
        arrows.push({ s, up: move('arrow-up', t('Move up'), -1), down: move('arrow-down', t('Move down'), 1) });
        markdown(item, b[s]);
      }
      const applyRow = slot.createDiv({ cls: 'git-conflict-actions git-conflict-apply' });
      syncArrows();
      applyRow.createEl('button', { text: t('Apply'), cls: 'mod-cta' }).onclick = () => void this.accept(slot, choice);
    }
    await Promise.all(renders);
    el.scrollTop = scroll;
  }

  // ponytail: each chunk renders on its own, so a list/code fence split by an open conflict renders in pieces.
  private renderMd(parent: HTMLElement, lines: string[]): Promise<void> {
    const out = parent.createDiv({ cls: 'markdown-rendered' });
    const src = lines.join('\n');
    if (!src.trim()) { out.createDiv({ cls: 'git-conflict-empty', text: t('(empty)') }); return Promise.resolve(); }
    const isMd = this.path.toLowerCase().endsWith('.md');
    return MarkdownRenderer.render(this.app, isMd ? src : '```\n' + src + '\n```', out, this.path, this.md ?? this);
  }

  /**
   * Write one conflict's result. The resolution merges with the text around it into one block
   * (e.g. it completes a code fence), so that block is re-rendered whole — off-screen first and
   * swapped in when ready, so nothing flickers.
   */
  private async accept(slot: HTMLElement, choice: Choice): Promise<void> {
    const body = slot.parentElement!;
    const index = Array.from(body.querySelectorAll('.git-conflict-slot')).indexOf(slot);
    const text = applyResolution(this.read(), index, kept(choice));
    this.choices.splice(index, 1);
    // Last conflict: the toolbar changes (Done / Mark as resolved), so a full render is due anyway.
    if (!this.choices.length) { await this.write(text); await this.render(); return; }
    this.key = this.stateKey(text); // the refresh our own write triggers must not rebuild the view
    await this.write(text);
    const near = (e: Element | null) => (e?.hasClass('git-conflict-same') ? [e] : []);
    const old = [...near(slot.previousElementSibling), slot, ...near(slot.nextElementSibling)];
    // The text block that now holds "before + resolution + after": the first one after `index` conflicts.
    let n = 0;
    const block = parseConflicts(text).find(b => (b.kind === 'conflict' ? (n++, false) : n === index));
    if (block?.kind === 'text') {
      const fresh = createDiv({ cls: 'git-conflict-same is-pending' });
      body.appendChild(fresh);
      await this.renderMd(fresh, block.lines);
      old[0].before(fresh);
      fresh.removeClass('is-pending');
    }
    old.forEach(e => e.remove());
    this.contentEl.querySelector('.git-count')?.setText(t('{n} conflict(s)', { n: this.choices.length }));
  }

  private async acceptAll(how: (index: number) => Resolution): Promise<void> {
    let n = 0;
    const blocks = parseConflicts(this.read()).map(b => b.kind === 'conflict' ? { kind: 'text' as const, lines: resolve(b, how(n++)) } : b);
    await this.write(serialize(blocks));
    this.choices = [];
    await this.render();
  }
}
