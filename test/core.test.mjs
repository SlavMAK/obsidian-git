// Smoke checks for the pure logic + the git wrapper against a real temp repo.
// Run: npm test  (builds main.js first; tests import the bundle's internals via a tiny side bundle)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, '.core.cjs');
await esbuild.build({
  stdin: { contents: `export * from './src/git'; export * as conflicts from './src/conflicts'; export * as lanes from './src/lanes'; export * as i18n from './src/i18n';`, resolveDir: join(here, '..'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent'
});
const { Git, conflicts, lanes, i18n, parseRemoteUrl, httpsUrl, sshUrl, AUTH_ERROR } = await import(outfile);

test('main.js loads in a renderer-like context', async () => {
  assert.ok(existsSync(join(here, '..', 'main.js')), 'run npm run build first');
  const { createRequire } = await import('node:module');
  const Module = (await import('node:module')).default;
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, ...r) { return req === 'obsidian' ? 'obsidian-stub' : orig.call(this, req, ...r); };
  class S {} 
  Module._cache['obsidian-stub'] = { id: 'obsidian-stub', filename: 'obsidian-stub', loaded: true, exports: new Proxy({}, { get: (_, k) => k === '__esModule' ? true : S }) };
  const req = createRequire(import.meta.url);
  const plugin = req(join(here, '..', 'main.js'));
  assert.equal(typeof plugin.default, 'function');
});

test('conflict parser: parse / resolve / serialize', () => {
  const text = ['a', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature', 'z'].join('\n');
  assert.ok(conflicts.hasConflictMarkers(text));
  const blocks = conflicts.parseConflicts(text);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[1], { kind: 'conflict', currentHeader: 'HEAD', current: ['ours'], incoming: ['theirs'], incomingHeader: 'feature' });
  assert.equal(conflicts.serialize(blocks), text);
  assert.equal(conflicts.applyResolution(text, 0, 'both'), 'a\nours\ntheirs\nz');
  assert.equal(conflicts.applyResolution(text, 0, 'incoming'), 'a\ntheirs\nz');
  assert.equal(conflicts.applyResolution(text, 0, ['incoming', 'current']), 'a\ntheirs\nours\nz');
  assert.equal(conflicts.applyResolution(text, 0, []), 'a\nz');
  // diff3 base section and an unterminated marker treated as text
  const d3 = ['<<<<<<< HEAD', 'o', '||||||| base', 'b', '=======', 't', '>>>>>>> x', '<<<<<<< stray'].join('\n');
  const b3 = conflicts.parseConflicts(d3);
  assert.deepEqual(b3[0].base, ['b']);
  assert.deepEqual(b3[1], { kind: 'text', lines: ['<<<<<<< stray'] });
});

test('lanes: merge and fork get separate lanes, joins collapse', () => {
  // D (merge of B and C) -> B -> A ; C -> A
  const rows = lanes.layout([
    { hash: 'D', parents: ['B', 'C'] },
    { hash: 'B', parents: ['A'] },
    { hash: 'C', parents: ['A'] },
    { hash: 'A', parents: [] }
  ]);
  assert.equal(rows[0].lane, 0);
  assert.deepEqual(rows[0].edges, [{ to: 0, merge: false }, { to: 1, merge: true }]);
  assert.equal(rows[2].lane, 1);
  assert.deepEqual(rows[2].through, [0]);
  assert.deepEqual(rows[3].joins, [1]);      // C's lane joins A
  assert.equal(rows[3].width, 2);
  assert.deepEqual(rows[3].edges, []);
  // only the tip has nothing above it; every other dot is entered from its lane
  assert.deepEqual(rows.map(r => r.incoming), [false, true, true, true]);
});

test('git wrapper against a temp repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ogit-'));
  const git = new Git({ cwd: dir, config: { 'user.name': 'T', 'user.email': 't@t' } });
  assert.equal(Git.isRepo(dir), false);
  await git.init();
  assert.equal(Git.isRepo(dir), true);
  writeFileSync(join(dir, 'a.md'), 'hello\n');
  let st = await git.status();
  assert.equal(st.head, '(initial)');
  assert.deepEqual(st.entries, [{ path: 'a.md', staged: false, state: '?', conflict: false }]);
  await git.add(['a.md']);
  st = await git.status();
  assert.equal(st.entries[0].staged, true);
  assert.equal(st.entries[0].state, 'A');
  await git.commit('first');
  writeFileSync(join(dir, 'a.md'), 'hello\nworld\n');
  st = await git.status();
  assert.deepEqual(st.entries, [{ path: 'a.md', staged: false, state: 'M', conflict: false }]);
  assert.match(await git.diff('a.md', false), /\+world/);
  // branch + conflict
  execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: dir });
  await git.addAll(); await git.commit('feature change');
  execFileSync('git', ['checkout', '-q', '-'], { cwd: dir });
  writeFileSync(join(dir, 'a.md'), 'hello\nmain\n');
  await git.addAll(); await git.commit('main change');
  const branches = await git.branches();
  assert.deepEqual(branches.map(b => [b.name, b.remote, b.current]).sort(), [['feature', false, false], [st.branch, false, true]].sort());
  await assert.rejects(git.run(['merge', 'feature']), /CONFLICT/);
  st = await git.status();
  assert.equal(st.merging, true);
  assert.deepEqual(st.entries, [{ path: 'a.md', staged: false, state: 'U', conflict: true }]);
  const log = await git.log();
  assert.equal(log.length, 3);
  assert.ok(log.some(c => c.refs.includes('HEAD')));
  assert.ok(log.some(c => c.refs.includes('feature')));
  await git.mergeAbort();
  assert.equal((await git.status()).merging, false);
});

test('config: unset key is empty, -c override and --global are visible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-cfg-'));
  const home = process.env.HOME; process.env.HOME = dir; // isolate ~/.gitconfig
  try {
    execFileSync('git', ['init'], { cwd: dir });
    assert.equal(await new Git({ cwd: dir }).config('user.name'), '');
    assert.equal(await new Git({ cwd: dir, config: { 'user.name': 'T' } }).config('user.name'), 'T');
    const git = new Git({ cwd: dir });
    await git.run(['config', '--global', 'user.email', 'g@g']);
    assert.equal(await git.config('user.email'), 'g@g');
  } finally { process.env.HOME = home; }
});

test('i18n: english fallback fills placeholders, ru entries keep the same placeholders', () => {
  assert.equal(i18n.t('Merge {name}', { name: 'dev' }), 'Merge dev'); // no window here -> English
  assert.equal(i18n.t('unknown {x}', { x: 1 }), 'unknown 1');
  const ph = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();
  for (const [k, v] of Object.entries(i18n.ru)) assert.equal(ph(v), ph(k), `placeholders differ for ${JSON.stringify(k)}`);
  // every key used in the sources exists in the dictionary
  const src = readdirSync(join(here, '..', 'src')).filter(f => f.endsWith('.ts') && f !== 'i18n.ts').map(f => readFileSync(join(here, '..', 'src', f), 'utf8')).join('\n');
  for (const m of src.matchAll(/\bt\((['"])((?:\\.|(?!\1).)*)\1/g)) {
    const key = m[2].replace(/\\n/g, '\n').replace(/\\'/g, "'");
    assert.ok(key in i18n.ru, `missing ru translation for ${JSON.stringify(key)}`);
  }
});

test('remote url: parse https/ssh/scp forms, rebuild with credentials', () => {
  for (const u of ['https://github.com/me/repo.git', 'https://old:tok@github.com/me/repo.git', 'ssh://git@github.com/me/repo.git', 'git@github.com:me/repo.git'])
    assert.deepEqual(parseRemoteUrl(u), { host: 'github.com', path: 'me/repo.git' }, u);
  assert.equal(parseRemoteUrl('/local/path'), null);
  assert.equal(httpsUrl('gitlab.com', 'g/r.git', 'oauth2', 'a b@c'), 'https://oauth2:a%20b%40c@gitlab.com/g/r.git');
  assert.equal(sshUrl('gitlab.com', 'g/r.git'), 'git@gitlab.com:g/r.git');
  assert.ok(AUTH_ERROR.test("fatal: Authentication failed for 'https://github.com/me/repo.git/'"));
  assert.ok(AUTH_ERROR.test('git@github.com: Permission denied (publickey).'));
  assert.ok(!AUTH_ERROR.test('error: failed to push some refs'));
});

test('remotes: add / set-url / remove', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ogit-'));
  const git = new Git({ cwd: dir });
  await git.init();
  assert.deepEqual(await git.remotesVerbose(), []);
  await git.remoteAdd('origin', 'https://example.com/a.git');
  assert.deepEqual(await git.remotesVerbose(), [{ name: 'origin', fetchUrl: 'https://example.com/a.git', pushUrl: 'https://example.com/a.git' }]);
  await git.remoteSetUrl('origin', 'git@example.com:b.git');
  assert.equal((await git.remotesVerbose())[0].fetchUrl, 'git@example.com:b.git');
  await git.remoteRemove('origin');
  assert.deepEqual(await git.remotes(), []);
});

test('undo last commit keeps changes staged and returns the message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ogit-'));
  const git = new Git({ cwd: dir, config: { 'user.name': 'T', 'user.email': 't@t' } });
  await git.init();
  writeFileSync(join(dir, 'a.md'), '1\n'); await git.addAll(); await git.commit('root');
  writeFileSync(join(dir, 'b.md'), '2\n'); await git.addAll(); await git.commit('second\n\nbody');
  assert.equal(await git.undoLastCommit(), 'second\n\nbody');
  let st = await git.status();
  assert.deepEqual(st.entries, [{ path: 'b.md', from: undefined, staged: true, state: 'A', conflict: false }]);
  assert.equal((await git.log()).length, 1);
  // Undoing the root commit as well leaves an empty repo with everything staged.
  await git.unstageAll(); execFileSync('git', ['clean', '-fq'], { cwd: dir });
  assert.equal(await git.undoLastCommit(), 'root');
  st = await git.status();
  assert.equal(st.head, '(initial)');
  assert.equal(st.entries[0].state, 'A');
});

test('merge: fast-forward succeeds, conflicting merge is left in progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ogit-'));
  const git = new Git({ cwd: dir, config: { 'user.name': 'T', 'user.email': 't@t' } });
  await git.init();
  writeFileSync(join(dir, 'a.md'), '1\n'); await git.addAll(); await git.commit('root');
  execFileSync('git', ['checkout', '-q', '-b', 'ff'], { cwd: dir });
  writeFileSync(join(dir, 'b.md'), '2\n'); await git.addAll(); await git.commit('ff commit');
  execFileSync('git', ['checkout', '-q', '-'], { cwd: dir });
  await git.merge('ff');
  assert.equal((await git.log()).length, 2);
  assert.equal((await git.status()).merging, false);
  await assert.rejects(git.merge('nope'), /not something we can merge/);
  execFileSync('git', ['checkout', '-q', '-b', 'clash'], { cwd: dir });
  writeFileSync(join(dir, 'a.md'), 'theirs\n'); await git.addAll(); await git.commit('clash');
  execFileSync('git', ['checkout', '-q', '-'], { cwd: dir });
  writeFileSync(join(dir, 'a.md'), 'ours\n'); await git.addAll(); await git.commit('ours');
  assert.equal(await git.merge('clash'), 'conflicts to resolve');
  const st = await git.status();
  assert.equal(st.merging, true);
  assert.equal(st.entries[0].conflict, true);
});
