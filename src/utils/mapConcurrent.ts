/** Run async work across `items` with at most `concurrency` in flight; preserves result order by index. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n === 0) return [];
  const cap = Math.max(1, Math.min(Math.floor(concurrency) || 1, n));
  const results: R[] = new Array(n);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}
