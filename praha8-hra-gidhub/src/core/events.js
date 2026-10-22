// Global event bus. on() returns an unsubscribe function; off() also works.
export class EventBus {
  constructor() { this.map = new Map(); }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name).add(fn);
    return () => this.off(name, fn);
  }
  once(name, fn) {
    const off = this.on(name, (d) => { off(); fn(d); });
    return off;
  }
  off(name, fn) { this.map.get(name)?.delete(fn); }
  emit(name, data) {
    const set = this.map.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(data); } catch (e) { console.error(`[events] handler for "${name}" failed:`, e); }
    }
  }
  clear() { this.map.clear(); }
}
export const events = new EventBus();
export default events;
