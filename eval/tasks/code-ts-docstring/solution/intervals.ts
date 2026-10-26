export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const xs = intervals.map(([a, b]) => (a <= b ? [a, b] : [b, a]) as [number, number]).sort((p, q) => p[0] - q[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of xs) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
