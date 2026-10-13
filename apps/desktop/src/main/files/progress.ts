// Local progress of one file source (file-sources-spec §4.4): userData/files/progress-<sourceId>.json.
import fs from 'node:fs';
import { prune, report, type ProgressDoc, type ProgressRecord } from '../../shared/files/progress';
import { JsonStore } from '../core/json-store';

export class ProgressStore {
  private store: JsonStore<ProgressDoc>;

  constructor(private readonly file: string) {
    this.store = new JsonStore<ProgressDoc>(file, { v: 1, records: {} });
    if (!this.store.value?.records || typeof this.store.value.records !== 'object') this.store.set({ v: 1, records: {} });
  }

  get doc(): ProgressDoc {
    return this.store.value;
  }

  get(rel: string): ProgressRecord | undefined {
    return Object.hasOwn(this.store.value.records, rel) ? this.store.value.records[rel] : undefined;
  }

  report(rel: string, file: { size: number; mtimeMs: number }, positionMs: number, durationMs: number): ProgressRecord {
    const rec = report(this.get(rel), file, positionMs, durationMs, Date.now());
    this.store.update((d) => prune({ v: 1, records: { ...d.records, [rel]: rec } }));
    return rec;
  }

  patch(rel: string, fn: (r: ProgressRecord) => void, file?: { size: number; mtimeMs: number }): void {
    // Own keys only, written as a computed key: a folder named __proto__ or constructor must not reach
    // Object.prototype (records is a plain object parsed from JSON).
    const r = this.get(rel) ?? (file ? report(undefined, file, 0, 0, Date.now()) : undefined);
    if (!r) return;
    fn(r);
    this.store.update((d) => ({ v: 1, records: { ...d.records, [rel]: r } }));
  }

  drop(rel: string): void {
    if (Object.hasOwn(this.store.value.records, rel)) this.store.update((d) => void delete d.records[rel]);
  }

  flush(): void {
    this.store.flush();
  }

  // Removing the source deletes its progress (after the renderer's confirmation).
  destroy(): void {
    this.store.set({ v: 1, records: {} });
    this.store.flush();
    fs.rmSync(this.file, { force: true });
  }
}
