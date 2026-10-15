// Side tables of checker links, indexed by node or symbol id.
//
// The checker caches values per node and per symbol. A cached value that many nodes or symbols
// have lives in a table of its own (a column) instead of a field of a links object, so a node or
// symbol costs a slot in each column it uses rather than a whole object, and a lookup is two
// array reads. Columns are stored in pages of `LinkPaging.Size` ids created on first write: a
// checker that touches part of a program (as each of several parallel checkers does) stores only
// the pages it touches.

/** Links are stored in pages of 256 ids. */
export const enum LinkPaging {
  Bits = 8,
  Size = 1 << Bits,
  Mask = Size - 1,
}

/** A page of values, indexed by the low bits of an id; undefined until a value in it is stored. */
export type LinkPage<T> = (T | undefined)[] | undefined;

/** Values by id; undefined where none is stored. */
export class LinkTable<T> {
  readonly pages: LinkPage<T>[] = [];

  get(id: number): T | undefined {
    const page = this.pages[id >> LinkPaging.Bits];
    return page !== undefined ? page[id & LinkPaging.Mask] : undefined;
  }

  set(id: number, value: T | undefined): void {
    const index = id >> LinkPaging.Bits;
    const page = this.pages[index];
    if (page !== undefined) page[id & LinkPaging.Mask] = value;
    else if (value !== undefined) newLinkPage(this.pages, index)[id & LinkPaging.Mask] = value;
  }

  clear(): void {
    this.pages.length = 0;
  }
}

/** Creates the page at `index`, filling the gap below it so the page list stays dense. */
export function newLinkPage<T>(pages: LinkPage<T>[], index: number): (T | undefined)[] {
  while (pages.length <= index) pages.push(undefined);
  const page: (T | undefined)[] = [];
  for (let i = 0; i < LinkPaging.Size; i++) page.push(undefined);
  pages[index] = page;
  return page;
}

/** Int32 values by id, zero where none is stored: flags and small counters. */
export class IntLinkTable {
  readonly pages: (Int32Array | undefined)[] = [];

  get(id: number): number {
    const page = this.pages[id >> LinkPaging.Bits];
    return page !== undefined ? page[id & LinkPaging.Mask]! : 0;
  }

  set(id: number, value: number): void {
    const index = id >> LinkPaging.Bits;
    const page = this.pages[index];
    if (page !== undefined) page[id & LinkPaging.Mask] = value;
    else if (value !== 0) this.newPage(index)[id & LinkPaging.Mask] = value;
  }

  private newPage(index: number): Int32Array {
    while (this.pages.length <= index) this.pages.push(undefined);
    const page = new Int32Array(LinkPaging.Size);
    this.pages[index] = page;
    return page;
  }

  clear(): void {
    this.pages.length = 0;
  }
}
