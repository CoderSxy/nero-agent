import { buildCreateSpanRecord } from '@mastra/core/storage';
import type { ObservabilityStorage } from '@mastra/core/storage';
import type { ObservabilityExporter, TracingEvent, InitExporterOptions } from '@mastra/core/observability';

type Record = ReturnType<typeof buildCreateSpanRecord>;

/** Best-effort completed traces only. Never queues promises on the database pool. */
export class BoundedStorageExporter implements ObservabilityExporter {
  name = 'nero-bounded-storage-exporter';
  private storage?: ObservabilityStorage;
  private queue: Record[] = [];
  private retained = 0;
  private draining?: Promise<void>;
  private stopped = false;
  private lastWarning = 0;
  private dropped = 0;

  async init(options: InitExporterOptions): Promise<void> {
    this.storage = await options.mastra?.getStorage()?.getStore('observability');
  }
  onTracingEvent(event: TracingEvent): void {
    // An ended-span snapshot is self-contained: dropping an earlier event leaves no lifecycle map.
    if (event.type !== 'span_ended') return;
    if (this.stopped || !this.storage || this.retained >= 128) { this.drop(1); return; }
    this.queue.push(buildCreateSpanRecord(event.exportedSpan));
    this.retained++;
    this.startDrain();
  }
  async exportTracingEvent(event: TracingEvent): Promise<void> { this.onTracingEvent(event); }
  private drop(count: number) {
    this.dropped += count;
    if (Date.now() - this.lastWarning > 60_000) {
      console.warn('Observability dropped completed spans (capacity, unavailable storage or write failure)', { dropped: this.dropped });
      this.lastWarning = Date.now();
    }
  }
  private startDrain(): void {
    if (this.draining || !this.queue.length) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.queue.length) this.startDrain();
    });
  }
  private async drain(): Promise<void> {
    while (this.queue.length) {
      const records = this.queue.splice(0, 32);
      try { await this.storage!.batchCreateSpans({ records }); }
      catch { this.drop(records.length); } // Drop, never retry/requeue beyond the hard budget.
      finally { this.retained -= records.length; }
    }
  }
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }
  async shutdown(): Promise<void> { this.stopped = true; await this.flush(); }
}
