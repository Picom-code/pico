// Small fuzzy subsequence matcher with scoring (prefix, word-start and consecutive bonuses).

export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const s = target.toLowerCase();
  if (s.startsWith(q)) return 1000 - s.length;
  let score = 0;
  let qi = 0;
  let prev = -2;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      score += 10;
      if (i === prev + 1) score += 15;
      if (i === 0 || /[\s/_\-.]/.test(s[i - 1])) score += 20;
      prev = i;
      qi++;
    }
  }
  if (qi < q.length) return 0;
  const sub = s.indexOf(q);
  if (sub >= 0) score += 200 - sub;
  return score - s.length * 0.1;
}

export function fuzzyFilter<T>(items: T[], query: string, key: (t: T) => string): T[] {
  if (!query) return items.slice();
  return items
    .map((it, i) => ({ it, i, s: fuzzyScore(query, key(it)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.it);
}

/** Indices in `target` that `query` matched (prefix/substring first, else greedy subsequence). */
export function fuzzyPositions(query: string, target: string): number[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const s = target.toLowerCase();
  const sub = s.indexOf(q);
  if (sub >= 0) return Array.from({ length: q.length }, (_, i) => sub + i);
  const out: number[] = [];
  let qi = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) if (s[i] === q[qi]) (out.push(i), qi++);
  return qi === q.length ? out : [];
}
