/** Minimal binary min-heap keyed by a numeric priority. */
export class MinHeap<T> {
  private items: T[] = [];
  private prios: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: T, prio: number): void {
    const items = this.items;
    const prios = this.prios;
    let i = items.length;
    items.push(item);
    prios.push(prio);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (prios[p] <= prio) break;
      items[i] = items[p];
      prios[i] = prios[p];
      i = p;
    }
    items[i] = item;
    prios[i] = prio;
  }

  pop(): T | undefined {
    const items = this.items;
    const prios = this.prios;
    if (items.length === 0) return undefined;
    const top = items[0];
    const lastItem = items.pop() as T;
    const lastPrio = prios.pop() as number;
    const n = items.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && prios[r] < prios[l] ? r : l;
        if (prios[c] >= lastPrio) break;
        items[i] = items[c];
        prios[i] = prios[c];
        i = c;
      }
      items[i] = lastItem;
      prios[i] = lastPrio;
    }
    return top;
  }

  clear(): void {
    this.items.length = 0;
    this.prios.length = 0;
  }
}
