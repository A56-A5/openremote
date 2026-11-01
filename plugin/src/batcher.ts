export type FileOp = "created" | "edited" | "deleted";
export type SessionStatus = "working" | "needs_you" | "done" | "error";

export type FileActivityRow = {
  sessionId: string;
  path: string;
  editCount: number;
  lastOp: FileOp;
  firstAt: number;
  lastAt: number;
};

/**
 * Aggregates file edits in memory per (session, path) and hands back deltas on
 * flush. The worker upserts `edit_count + delta` every ~8s while dirty and at
 * turn end, so the DB never sees per-edit updates.
 */
export class FileActivityBatcher {
  private rows = new Map<string, FileActivityRow>();
  private pending = false;

  get dirty(): boolean {
    return this.pending;
  }

  record(sessionId: string, path: string, op: FileOp, at: number = Date.now()): void {
    if (!sessionId || !path) return;
    const key = `${sessionId}\u0000${path}`;
    const cur = this.rows.get(key);
    if (!cur) {
      this.rows.set(key, { sessionId, path, editCount: 1, lastOp: op, firstAt: at, lastAt: at });
    } else {
      cur.editCount += 1;
      cur.lastOp = op;
      cur.lastAt = Math.max(cur.lastAt, at);
    }
    this.pending = true;
  }

  /** Returns accumulated deltas and clears the buffer. */
  flush(): FileActivityRow[] {
    if (!this.rows.size) {
      this.pending = false;
      return [];
    }
    const out = [...this.rows.values()];
    this.rows.clear();
    this.pending = false;
    return out;
  }
}

type PendingStatus = {
  status: SessionStatus;
  readyAt: number;
};

/**
 * Status writer with debounce: busy→idle is delayed ~3s so rapid
 * busy/idle flapping never reaches the DB; `needs_you` wins immediately and
 * overrides everything. Rows are only emitted when the status actually changed.
 */
export class StatusDebouncer {
  private desired = new Map<string, SessionStatus>();
  private emitted = new Map<string, SessionStatus>();
  private pending = new Map<string, PendingStatus>();
  private readonly idleDelayMs: number;
  private readonly now: () => number;

  constructor(opts: { idleDelayMs?: number; now?: () => number } = {}) {
    this.idleDelayMs = opts.idleDelayMs ?? 3000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record what OpenCode currently reports for a session.
   * Returns true when the caller must write `sessions.status` right now
   * (`done` is always deferred to `tick` for the busy→idle debounce).
   */
  setDesired(sessionId: string, status: SessionStatus, at: number = this.now()): boolean {
    this.desired.set(sessionId, status);
    if (status === "done") {
      this.pending.set(sessionId, { status, readyAt: at + this.idleDelayMs });
      return false;
    }
    this.pending.delete(sessionId);
    return this.commit(sessionId, status);
  }

  /** Statuses that changed and are ready to write. */
  tick(at: number = this.now()): { sessionId: string; status: SessionStatus }[] {
    const out: { sessionId: string; status: SessionStatus }[] = [];
    for (const [sessionId, entry] of [...this.pending]) {
      if (entry.readyAt > at) continue;
      this.pending.delete(sessionId);
      const desired = this.desired.get(sessionId);
      // only fire if it is still what we want (it may have flipped back to busy)
      if (desired !== entry.status) continue;
      out.push({ sessionId, status: entry.status });
    }
    for (const { sessionId, status } of out) this.commit(sessionId, status);
    return out;
  }

  /** Force an immediate write, bypassing the busy→idle debounce. */
  flushNow(sessionId: string, status: SessionStatus): boolean {
    this.desired.set(sessionId, status);
    this.pending.delete(sessionId);
    return this.commit(sessionId, status);
  }

  /** Last status actually written for a session, if any. */
  lastEmitted(sessionId: string): SessionStatus | undefined {
    return this.emitted.get(sessionId);
  }

  /** Remember a status without emitting it (used when a row is first created). */
  seed(sessionId: string, status: SessionStatus): void {
    this.emitted.set(sessionId, status);
  }

  private commit(sessionId: string, status: SessionStatus): boolean {
    if (this.emitted.get(sessionId) === status) return false;
    this.emitted.set(sessionId, status);
    return true;
  }
}

export type MessageInfo = {
  id: string;
  role: "user" | "assistant";
  /** epoch ms - assistant messages only complete once `time.completed` exists */
  completedAt?: number;
};

/**
 * Writes a message row exactly once, and only once the message is complete.
 * Re-delivered SSE events (reconnects) are no-ops.
 */
export class MessageDedupe {
  private written = new Set<string>();

  has(id: string): boolean {
    return this.written.has(id);
  }

  /** true → the caller should upsert this message row. */
  consider(info: MessageInfo): boolean {
    if (!info?.id) return false;
    if (this.written.has(info.id)) return false;
    if (info.role === "assistant" && !info.completedAt) return false;
    this.written.add(info.id);
    return true;
  }

  /** Used when a message was written from a resync fetch rather than an event. */
  markWritten(id: string): void {
    if (id) this.written.add(id);
  }
}
