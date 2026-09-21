import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import type GitPlugin from './main';
import { REFRESH_EVENT } from './main';
import type { Commit } from './git';
import { layout, type Row } from './lanes';
import { relativeDate } from './ui';

export const GRAPH_VIEW = 'git-graph';
const COLORS = ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000', '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00'];
const H = 26, W = 14, R = 4;
const SVG = 'http://www.w3.org/2000/svg';

/** Commit graph: SVG lanes per row + refs, subject, author, relative date. Click a row for details. */
export class GraphView extends ItemView {
  private limit = 300;
  private expanded: string | null = null;
  private commits: Commit[] = [];

  constructor(leaf: WorkspaceLeaf, private plugin: GitPlugin) { super(leaf); }
  getViewType(): string { return GRAPH_VIEW; }
  getDisplayText(): string { return 'Commit graph'; }
  getIcon(): string { return 'git-graph'; }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on(REFRESH_EVENT as 'quit', () => void this.reload()));
    await this.reload();
  }

  private async reload(): Promise<void> {
    if (!this.plugin.isRepo) { this.contentEl.empty(); this.contentEl.createDiv({ cls: 'git-empty', text: 'Not a git repository' }); return; }
    try { this.commits = await this.plugin.git.log(this.limit); }
    catch (e) { this.contentEl.empty(); this.contentEl.createDiv({ cls: 'git-empty', text: (e as Error).message }); return; }
    this.render();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass('git-graph');
    const rows = layout(this.commits);
    const width = Math.max(1, ...rows.map(r => r.width)) * W;
    const table = el.createDiv({ cls: 'git-graph-table' });
    if (!this.commits.length) table.createDiv({ cls: 'git-empty', text: 'No commits yet' });
    this.commits.forEach((c, i) => {
      const row = table.createDiv({ cls: 'git-graph-row' });
      row.appendChild(this.svg(rows[i], width));
      const text = row.createDiv({ cls: 'git-graph-text' });
      for (const ref of c.refs) {
        const isTag = ref.startsWith('tag: ');
        text.createSpan({ text: ref.replace(/^tag: /, ''), cls: `git-ref ${ref === 'HEAD' ? 'git-ref-head' : isTag ? 'git-ref-tag' : ref.includes('/') ? 'git-ref-remote' : 'git-ref-local'}` });
      }
      text.createSpan({ text: c.subject, cls: 'git-graph-subject' });
      row.createSpan({ text: c.author, cls: 'git-graph-author' });
      row.createSpan({ text: relativeDate(c.date), cls: 'git-graph-date', attr: { 'aria-label': c.date.toLocaleString() } });
      row.createSpan({ text: c.hash.slice(0, 7), cls: 'git-graph-hash' });
      row.onclick = () => { this.expanded = this.expanded === c.hash ? null : c.hash; this.render(); };
      if (this.expanded === c.hash) void this.details(table.createDiv({ cls: 'git-graph-details' }), c);
    });
    if (this.commits.length >= this.limit) {
      const more = el.createEl('button', { text: 'Load more' });
      more.onclick = () => { this.limit *= 2; void this.reload(); };
    }
  }

  private async details(el: HTMLElement, c: Commit): Promise<void> {
    const head = el.createDiv({ cls: 'git-graph-details-head' });
    head.createEl('code', { text: c.hash });
    head.createSpan({ text: ` ${c.author} <${c.email}> · ${c.date.toLocaleString()}` });
    if (c.parents.length > 1) head.createSpan({ text: ` · merge of ${c.parents.map(p => p.slice(0, 7)).join(', ')}` });
    el.createDiv({ cls: 'git-graph-message', text: [c.subject, c.body].filter(Boolean).join('\n\n') });
    const files = await this.plugin.git.show(c.hash).catch(() => []);
    const list = el.createDiv({ cls: 'git-list' });
    for (const f of files) {
      const row = list.createDiv({ cls: 'git-file' });
      row.createSpan({ text: f.path, cls: `git-file-name git-state-${f.status}` });
      row.createSpan({ text: f.status, cls: `git-badge-letter git-state-${f.status}` });
      row.onclick = ev => { ev.stopPropagation(); void this.plugin.openFile(f.path); };
    }
  }

  private svg(r: Row, width: number): SVGElement {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('width', String(width));
    s.setAttribute('height', String(H));
    s.classList.add('git-graph-svg');
    const x = (lane: number) => lane * W + W / 2;
    const color = (lane: number) => COLORS[lane % COLORS.length];
    const path = (d: string, lane: number) => {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', d); p.setAttribute('stroke', color(lane)); p.setAttribute('fill', 'none'); p.setAttribute('stroke-width', '2');
      s.appendChild(p);
    };
    for (const t of r.through) path(`M${x(t)},0 V${H}`, t);
    for (const j of r.joins) path(`M${x(j)},0 C${x(j)},${H / 2} ${x(r.lane)},0 ${x(r.lane)},${H / 2}`, j);
    for (const e of r.edges) {
      if (e.to === r.lane) path(`M${x(r.lane)},${H / 2} V${H}`, r.lane);
      else path(`M${x(r.lane)},${H / 2} C${x(r.lane)},${H} ${x(e.to)},${H / 2} ${x(e.to)},${H}`, e.to);
    }
    const dot = document.createElementNS(SVG, 'circle');
    dot.setAttribute('cx', String(x(r.lane))); dot.setAttribute('cy', String(H / 2)); dot.setAttribute('r', String(R));
    dot.setAttribute('fill', color(r.lane));
    if (r.edges.some(e => e.merge)) { dot.setAttribute('fill', 'var(--background-primary)'); dot.setAttribute('stroke', color(r.lane)); dot.setAttribute('stroke-width', '2'); }
    s.appendChild(dot);
    return s;
  }
}
