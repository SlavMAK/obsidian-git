import { App, Modal, Notice, Setting } from 'obsidian';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { httpsUrl, parseRemoteUrl, sshUrl } from './git';
import { choose, prompt } from './ui';
import type GitPlugin from './main';
import { t } from './i18n';

const execFileAsync = promisify(execFile);

/** Remote rejected us: let the user pick a sign-in method and rewrite the remote URL accordingly. */
export async function fixAuth(plugin: GitPlugin, label: string): Promise<void> {
  const remote = (await plugin.git.remotesVerbose().catch(() => []))[0];
  const url = remote && parseRemoteUrl(remote.fetchUrl);
  if (!remote || !url) { new Notice(t('{label} failed: could not sign in to the remote', { label }), 10_000); return; }
  const { app } = plugin;
  const setUrl = (u: string) => plugin.run(t('Set remote URL'), () => plugin.git.remoteSetUrl(remote.name, u), true);

  const pick = await choose(app, t('Sign in required'), t('{label} failed: {host} did not accept the connection. How do you want to sign in?', { label, host: url.host }), [
    { label: t('Access token'), desc: t("A personal access token from GitHub or GitLab. Stored in this vault's .git/config.") },
    { label: t('Login and password'), desc: t('Your account login and password. Most hosts require a token instead.') },
    { label: t('SSH key'), desc: t('Show (or create) an SSH key and add it to your GitHub/GitLab account.') }
  ]);
  if (pick === 0) {
    const token = (await prompt(app, t('Access token for {host}', { host: url.host }), 'ghp_… / glpat-…', '', 'password'))?.trim();
    if (token && await setUrl(httpsUrl(url.host, url.path, 'oauth2', token))) new Notice(t('Token saved. Try {label} again.', { label: label.toLowerCase() }));
  } else if (pick === 1) {
    const login = (await prompt(app, t('Login for {host}', { host: url.host })))?.trim();
    const password = login && (await prompt(app, t('Password for {login}@{host}', { login, host: url.host }), '', '', 'password'))?.trim();
    if (password && await setUrl(httpsUrl(url.host, url.path, login, password))) new Notice(t('Credentials saved. Try {label} again.', { label: label.toLowerCase() }));
  } else if (pick === 2) {
    try {
      const key = await sshPublicKey(await plugin.git.config('user.email') || os.hostname());
      const switched = !/^git@/.test(remote.fetchUrl) && await setUrl(sshUrl(url.host, url.path));
      new SshKeyModal(app, key, url.host, switched ? remote.name : null).open();
    } catch (e) {
      new Notice(t('Could not read or create an SSH key:\n{msg}', { msg: e instanceof Error ? e.message : String(e) }), 10_000);
    }
  }
}

/** First `~/.ssh/*.pub` (preferring id_ed25519), generating a passphrase-less ed25519 key when there is none. */
// ponytail: ssh only tries default key names; a lone ~/.ssh/work.pub is shown but not used. Add an IdentityFile config if that bites.
async function sshPublicKey(comment: string): Promise<string> {
  const dir = path.join(os.homedir(), '.ssh');
  const pubs = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.pub')) : [];
  let pub = pubs.find(f => f === 'id_ed25519.pub') ?? pubs[0];
  if (!pub) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', path.join(dir, 'id_ed25519')], { windowsHide: true });
    pub = 'id_ed25519.pub';
  }
  return fs.readFileSync(path.join(dir, pub), 'utf8').trim();
}

class SshKeyModal extends Modal {
  constructor(app: App, private key: string, private host: string, private switchedRemote: string | null) { super(app); }
  onOpen(): void {
    const el = this.contentEl;
    this.titleEl.setText(t('Your SSH public key'));
    el.createEl('p', { text: t('Copy this key and add it to your account. The key is public and safe to share:') });
    el.createEl('textarea', { text: this.key, cls: 'git-ssh-key', attr: { readonly: '', rows: '4' } });
    new Setting(el).addButton(b => b.setCta().setButtonText(t('Copy key')).onClick(async () => {
      await navigator.clipboard.writeText(this.key); b.setButtonText(t('Copied'));
    }));
    const steps = el.createEl('ol');
    const h = this.host.toLowerCase();
    if (!h.includes('gitlab')) steps.createEl('li', { text: t('GitHub: click your avatar → Settings → SSH and GPG keys → New SSH key → paste the key → Add SSH key.') });
    if (!h.includes('github')) steps.createEl('li', { text: t('GitLab: click your avatar → Preferences → SSH Keys → Add new key → paste the key → Add key.') });
    steps.createEl('li', { text: this.switchedRemote
      ? t("Remote '{remote}' now uses SSH ({url}). Push or pull again.", { remote: this.switchedRemote, url: sshUrl(this.host, '…') })
      : t('Push or pull again.') });
  }
}
