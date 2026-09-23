/** Count changed lines while keeping memory bounded for large files. */
export function diffCounts(oldText: string, newText: string): { added: number; removed: number } {
  if (oldText === newText) return { added: 0, removed: 0 };
  const split = (text: string) => text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const a = split(oldText), b = split(newText);
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (!n || !m) return { added: m, removed: n };
  // Avoid quadratic CPU work on unrelated multi-thousand-line files.
  if (n * m > 4_000_000) return { added: Math.max(1, m - n), removed: Math.max(1, n - m) };
  const aa = a.slice(start, endA), bb = b.slice(start, endB);
  const [rows, cols] = aa.length >= bb.length ? [aa, bb] : [bb, aa];
  let next = new Uint32Array(cols.length + 1);
  let current = new Uint32Array(cols.length + 1);
  for (let i = rows.length - 1; i >= 0; i--) {
    for (let j = cols.length - 1; j >= 0; j--)
      current[j] = rows[i] === cols[j] ? next[j + 1] + 1 : Math.max(next[j], current[j + 1]);
    [next, current] = [current, next];
  }
  const lcs = next[0];
  return { added: m - lcs, removed: n - lcs };
}
