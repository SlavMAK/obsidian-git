import { App, FuzzySuggestModal, Modal, Setting, setIcon } from 'obsidian';
import type { Branch } from './git';
import type GitPlugin from './main';
import { t } from './i18n';

export function confirm(app: App, title: string, body: string, cta = 'OK', danger = false): Promise<boolean> {
  return new Promise(resolve => {
    const m = new (class extends Modal {
      onOpen() {
        this.titleEl.setText(title);
        this.contentEl.createEl('p', { text: body });
        new Setting(this.contentEl)
          .addButton(b => { b.setButtonText(t('Cancel')).onClick(() => { resolve(false); this.close(); }); })
          .addButton(b => { b.setButtonText(cta).onClick(() => { resolve(true); this.close(); }); if (danger) b.setWarning(); else b.setCta(); });
      }
      onClose() { resolve(false); }
    })(app);
    m.open();
  });
}

export function prompt(app: App, title: string, placeholder = '', initial = '', type: 'text' | 'password' = 'text'): Promise<string | null> {
  return new Promise(resolve => {
    let value = initial;
    const m = new (class extends Modal {
      onOpen() {
        this.titleEl.setText(title);
        const input = this.contentEl.createEl('input', { type, value: initial, placeholder, cls: 'git-prompt-input' });
        input.addEventListener('input', () => value = input.value);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { resolve(value); this.close(); } });
        new Setting(this.contentEl).addButton(b => b.setCta().setButtonText(t('OK')).onClick(() => { resolve(value); this.close(); }));
        input.focus();
      }
      onClose() { resolve(null); }
    })(app);
    m.open();
  });
}

/** Pick one of several actions; resolves the chosen index, or null on cancel. */
export function choose(app: App, title: string, body: string, options: { label: string; desc: string }[]): Promise<number | null> {
  return new Promise(resolve => {
    const m = new (class extends Modal {
      onOpen() {
        this.titleEl.setText(title);
        this.contentEl.createEl('p', { text: body });
        options.forEach((o, i) => new Setting(this.contentEl).setName(o.label).setDesc(o.desc)
          .addButton(b => b.setCta().setButtonText(t('Choose')).onClick(() => { resolve(i); this.close(); })));
      }
      onClose() { resolve(null); }
    })(app);
    m.open();
  });
}

type BranchItem = Branch | { create: true };

/** VS Code style branch picker: "Create new branch…", then local, then remote branches. */
export class BranchModal extends FuzzySuggestModal<BranchItem> {
  constructor(app: App, private branches: Branch[], private onPick: (item: BranchItem) => void, private mode: 'checkout' | 'merge' = 'checkout') {
    super(app);
    this.setPlaceholder(mode === 'merge' ? t('Select a branch to merge into the current one') : t('Select a branch to checkout'));
  }
  getItems(): BranchItem[] {
    const list = this.branches.filter(b => this.mode === 'checkout' || !b.current);
    return [...(this.mode === 'checkout' ? [{ create: true } as BranchItem] : []), ...list.filter(b => !b.remote), ...list.filter(b => b.remote)];
  }
  getItemText(item: BranchItem): string { return 'create' in item ? 'Create new branch' : item.name; }
  renderSuggestion(match: { item: BranchItem }, el: HTMLElement): void {
    const item = match.item;
    el.addClass('git-branch-item');
    const icon = el.createSpan({ cls: 'git-branch-icon' });
    if ('create' in item) { setIcon(icon, 'plus'); el.createSpan({ text: t('Create new branch…') }); return; }
    setIcon(icon, item.remote ? 'cloud' : 'git-branch');
    el.createSpan({ text: item.name, cls: 'git-branch-name' });
    el.createSpan({ text: t(item.current ? 'current' : item.remote ? 'remote' : 'local'), cls: `git-badge git-badge-${item.current ? 'current' : item.remote ? 'remote' : 'local'}` });
    el.createSpan({ text: `${item.hash} ${item.subject}`, cls: 'git-branch-subject' });
  }
  onChooseItem(item: BranchItem): void { this.onPick(item); }
}

export function relativeDate(d: Date): string {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  const units: [number, string][] = [[60, 's'], [60, 'm'], [24, 'h'], [7, 'd'], [4.35, 'w'], [12, 'mo'], [Infinity, 'y']];
  let v = s;
  for (const [n, u] of units) { if (v < n) return t('{n}{unit} ago', { n: Math.floor(v), unit: t(u) }); v /= n; }
  return d.toLocaleDateString();
}

/** Manage remotes: list with URLs, add, change URL, remove. */
export class RemotesModal extends Modal {
  constructor(app: App, private plugin: GitPlugin) { super(app); }
  onOpen(): void { this.titleEl.setText(t('Remotes')); void this.render(); }
  private async render(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    const remotes = await this.plugin.git.remotesVerbose().catch(() => []);
    if (!remotes.length) el.createEl('p', { text: t('No remotes configured.'), cls: 'git-empty' });
    for (const r of remotes) {
      const s = new Setting(el).setName(r.name).setDesc(r.pushUrl && r.pushUrl !== r.fetchUrl ? `${r.fetchUrl} (push: ${r.pushUrl})` : r.fetchUrl);
      s.addExtraButton(b => b.setIcon('pencil').setTooltip(t('Change URL')).onClick(async () => {
        const url = await prompt(this.app, t("URL for '{name}'", { name: r.name }), 'git@github.com:user/repo.git', r.fetchUrl);
        if (url?.trim() && url.trim() !== r.fetchUrl) { await this.plugin.run(t('Set URL'), () => this.plugin.git.remoteSetUrl(r.name, url.trim()), true); await this.render(); }
      }));
      s.addExtraButton(b => b.setIcon('trash').setTooltip(t('Remove remote')).onClick(async () => {
        if (await confirm(this.app, t('Remove remote'), t("Remove remote '{name}'? Remote-tracking branches will be deleted locally.", { name: r.name }), t('Remove'), true)) {
          await this.plugin.run(t('Remove remote'), () => this.plugin.git.remoteRemove(r.name), true); await this.render();
        }
      }));
    }
    new Setting(el).addButton(b => b.setCta().setButtonText(t('Add remote')).onClick(async () => {
      const name = await prompt(this.app, t('Remote name'), 'origin', remotes.length ? '' : 'origin');
      if (!name?.trim()) return;
      const url = await prompt(this.app, t("URL for '{name}'", { name: name.trim() }), 'git@github.com:user/repo.git');
      if (!url?.trim()) return;
      if (await this.plugin.run(t('Add remote'), () => this.plugin.git.remoteAdd(name.trim(), url.trim()))) await this.render();
    }));
  }
}
