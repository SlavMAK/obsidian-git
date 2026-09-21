/** Merge-conflict marker parsing, VS Code merge-conflict extension style. */

export interface ConflictBlock {
  kind: 'conflict';
  currentHeader: string;   // text after <<<<<<<
  current: string[];
  base?: string[];         // diff3 style ||||||| section
  incoming: string[];
  incomingHeader: string;  // text after >>>>>>>
}
export interface TextBlock { kind: 'text'; lines: string[]; }
export type Block = ConflictBlock | TextBlock;

const START = /^<{7}(?: (.*))?$/, BASE = /^\|{7}/, SEP = /^={7}$/, END = /^>{7}(?: (.*))?$/;

export function hasConflictMarkers(text: string): boolean {
  return /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);
}

export function parseConflicts(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let plain: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = START.exec(lines[i]);
    if (!m) { plain.push(lines[i]); continue; }
    // Scan ahead for a well-formed block; otherwise treat the marker as text.
    const block: ConflictBlock = { kind: 'conflict', currentHeader: m[1] ?? '', current: [], incoming: [], incomingHeader: '' };
    let j = i + 1, section: 'current' | 'base' | 'incoming' = 'current', closed = false;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (section === 'current' && BASE.test(l)) { section = 'base'; block.base = []; continue; }
      if (section !== 'incoming' && SEP.test(l)) { section = 'incoming'; continue; }
      const e = END.exec(l);
      if (section === 'incoming' && e) { block.incomingHeader = e[1] ?? ''; closed = true; break; }
      if (START.test(l)) break; // nested/unterminated: give up on this one
      (section === 'current' ? block.current : section === 'base' ? block.base! : block.incoming).push(l);
    }
    if (!closed) { plain.push(lines[i]); continue; }
    if (plain.length) blocks.push({ kind: 'text', lines: plain });
    plain = [];
    blocks.push(block);
    i = j;
  }
  if (plain.length) blocks.push({ kind: 'text', lines: plain });
  return blocks;
}

export type Resolution = 'current' | 'incoming' | 'both';

export function resolve(block: ConflictBlock, how: Resolution): string[] {
  if (how === 'current') return block.current;
  if (how === 'incoming') return block.incoming;
  return [...block.current, ...block.incoming];
}

export function serialize(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'text') { out.push(...b.lines); continue; }
    out.push(`<<<<<<< ${b.currentHeader}`.trimEnd(), ...b.current);
    if (b.base) out.push('|||||||', ...b.base);
    out.push('=======', ...b.incoming, `>>>>>>> ${b.incomingHeader}`.trimEnd());
  }
  return out.join('\n');
}

/** Replace the n-th conflict block with its resolution and return the new file text. */
export function applyResolution(text: string, index: number, how: Resolution): string {
  const blocks = parseConflicts(text);
  let n = -1;
  const next: Block[] = blocks.map(b => {
    if (b.kind !== 'conflict' || ++n !== index) return b;
    return { kind: 'text', lines: resolve(b, how) };
  });
  return serialize(next);
}
