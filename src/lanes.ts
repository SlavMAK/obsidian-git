/**
 * "Active lanes" layout for a commit graph (commits newest first, date/topo order).
 * `lanes[i]` holds the hash expected next in column i. A commit takes the lane reserved
 * for it (or the first free one), its first parent inherits that lane, extra parents get
 * their own lane. Other lanes that also expected this hash join into it (fork join).
 */
export interface Row {
  lane: number;                        // column of the dot
  through: number[];                   // lanes drawn straight through this row
  joins: number[];                     // lanes from above curving into the dot
  edges: { to: number; merge: boolean }[]; // dot -> lane in the next row
  width: number;
}

export function layout(commits: { hash: string; parents: string[] }[]): Row[] {
  const lanes: (string | null)[] = [];
  const rows: Row[] = [];
  const free = () => { const i = lanes.indexOf(null); return i === -1 ? lanes.push(null) - 1 : i; };
  for (const c of commits) {
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) { lane = free(); lanes[lane] = c.hash; }
    const joins: number[] = [];
    lanes.forEach((h, i) => { if (h === c.hash && i !== lane) { joins.push(i); lanes[i] = null; } });
    const through = lanes.map((h, i) => (h && i !== lane ? i : -1)).filter(i => i >= 0);
    const [first, ...others] = c.parents;
    lanes[lane] = first ?? null;
    const edges: Row['edges'] = first ? [{ to: lane, merge: false }] : [];
    for (const p of others) {
      let to = lanes.indexOf(p);
      if (to === -1) { to = free(); lanes[to] = p; }
      edges.push({ to, merge: true });
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const width = Math.max(lane, ...through, ...joins, ...edges.map(e => e.to)) + 1;
    rows.push({ lane, through, joins, edges, width });
  }
  return rows;
}
