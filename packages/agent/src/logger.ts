export interface Logger {
  event(name: string, data?: Record<string, unknown>): void;
}

/** Structured JSON lines on stderr, so stdout stays clean for the review output. */
export const stderrLogger: Logger = {
  event(name, data = {}) {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), event: name, ...data })}\n`,
    );
  },
};

export const silentLogger: Logger = { event() {} };

/** Collects events in memory; used by tests. */
export class MemoryLogger implements Logger {
  readonly events: { name: string; data: Record<string, unknown> }[] = [];
  event(name: string, data: Record<string, unknown> = {}): void {
    this.events.push({ name, data });
  }
}
