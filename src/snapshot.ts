import type { FlagValue } from "./flagValue.js";

/**
 * Everything a synchronous read needs, in one immutable value. A single reference updated
 * atomically rather than several independently-updated fields, so a read can never observe a
 * half-applied refresh — fresh values from one payload alongside a device ID from another.
 * (JavaScript is single-threaded, but an `await` point mid-update would create exactly the
 * same torn read; one-reference-swap removes the possibility instead of reasoning about it.)
 */
export interface Snapshot {
  /** Values from the most recent accepted payload. */
  readonly fresh: ReadonlyMap<string, FlagValue> | null;
  /** Values from the durable cache: the last payload this browser ever accepted. */
  readonly cached: ReadonlyMap<string, FlagValue> | null;
  readonly deviceId: string | null;
  readonly lastSuccessfulFetchEpochMillis: number | null;
  readonly isStarted: boolean;
  /** The KEYS of the tags a fetch will send — built-in and custom merged, sorted. Keys
   * only: tag values never enter the snapshot, for the same reason they never enter a
   * console line. */
  readonly sentTagKeys: readonly string[];
}

const EMPTY: Snapshot = {
  fresh: null,
  cached: null,
  deviceId: null,
  lastSuccessfulFetchEpochMillis: null,
  isStarted: false,
  sentTagKeys: [],
};

/** Holds the snapshot for the synchronous read path (`isEnabled` may run in a render pass
 * many times per frame: reads are one property load of an immutable object). */
export class SnapshotStore {
  private snapshot: Snapshot = EMPTY;

  get current(): Snapshot {
    return this.snapshot;
  }

  update(transform: (snapshot: Snapshot) => Snapshot): void {
    this.snapshot = transform(this.snapshot);
  }

  reset(): void {
    this.snapshot = EMPTY;
  }
}
