import * as esbuild from 'esbuild';
import { builtinModules } from 'node:module';

const watch = process.argv.includes('--watch');
const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  // Obsidian's renderer provides these.
  external: ['obsidian', 'electron', '@codemirror/state', '@codemirror/view', ...builtinModules, ...builtinModules.map(m => `node:${m}`)],
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info'
});
if (watch) { await ctx.watch(); } else { await ctx.rebuild(); await ctx.dispose(); }
