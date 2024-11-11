export class Multimap<K, V> {
  static fromEntries<K, V>(entries: [K, V[]][]) {
    const m = new Multimap<K, V>();
    for (const [key, values] of entries)
      m.setAll(key, values);
    return m;
  }

  private _map: Map<K, Set<V>> = new Map();

  constructor(entries: [K, V[]][] = []) {
    for (const [k, v] of entries)
      this.setAll(k, v);
  }

  addAllFromMap(map: Map<K, V>) {
    for (const [key, value] of map)
      this.set(key, value);
  }

  map<Q>(callback: (key: K, values: Set<V>) => Q): Q[] {
    const result: Q[] = [];
    for (const [key, value] of this._map)
      result.push(callback(key, value));
    return result;
  }

  [Symbol.iterator]() {
    return this._map.entries();
  }

  hasAny(key: K) {
    return this._map.has(key);
  }

  has(key: K, value: V): boolean {
    return this._map.get(key)?.has(value) ?? false;
  }

  set(key: K, value: V) {
    let s = this._map.get(key);
    if (!s) {
      s = new Set<V>;
      this._map.set(key, s);
    }
    s.add(value);
  }

  get size() {
    return this._map.size;
  }

  setAll(key: K, values: Iterable<V>) {
    let s = this._map.get(key);
    if (!s) {
      s = new Set<V>;
      this._map.set(key, s);
    }
    for (const v of values)
      s.add(v);
  }

  delete(key: K, value: V) {
    let s = this._map.get(key);
    if (!s)
      return;
    s.delete(value);
  }

  keys(): Iterable<K> {
    return this._map.keys();
  }

  *values() {
    for (const set of this._map.values())
      yield *set.keys();
  }

  getAll(key: K) {
    let s = this._map.get(key);
    return s ? [...s] : [];
  }

  deleteAll(key: K) {
    this._map.delete(key);
  }
}
