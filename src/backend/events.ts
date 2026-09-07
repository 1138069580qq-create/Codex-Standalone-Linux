import { randomUUID } from "crypto";
export interface ConsoleEvent {
  cursor: string;
  type:
    | "delta"
    | "item"
    | "status"
    | "approval"
    | "approvalResolved"
    | "reset"
    | "connection"
    | "limits";
  projectId?: string;
  threadId?: string;
  payload: any;
}
export class ReplayHub {
  private epoch = randomUUID();
  private seq = 0;
  private bytes = 0;
  private events: Array<{ event: ConsoleEvent; size: number }> = [];
  private listeners = new Set<(event: ConsoleEvent) => void>();
  constructor(
    private maxEvents = 2048,
    private maxBytes = 4 * 1024 * 1024
  ) {}
  get cursor(): string {
    return `${this.epoch}:${this.seq}`;
  }
  publish(event: Omit<ConsoleEvent, "cursor">): ConsoleEvent {
    const item = JSON.parse(
      JSON.stringify({ ...event, cursor: `${this.epoch}:${++this.seq}` })
    ) as ConsoleEvent;
    const size = Buffer.byteLength(JSON.stringify(item));
    this.events.push({ event: item, size });
    this.bytes += size;
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes)
      this.bytes -= this.events.shift()!.size;
    for (const listener of this.listeners) listener(item);
    return item;
  }
  replay(cursor: string, projectId: string, threadId: string): ConsoleEvent[] | null {
    const at = cursor.lastIndexOf(":");
    const seq = Number(cursor.slice(at + 1));
    const first = this.events.length
      ? Number(this.events[0].event.cursor.split(":").pop())
      : this.seq + 1;
    if (
      cursor.slice(0, at) !== this.epoch ||
      !Number.isSafeInteger(seq) ||
      seq < first - 1 ||
      seq > this.seq
    )
      return null;
    return this.events
      .map((e) => e.event)
      .filter(
        (e) => Number(e.cursor.split(":").pop()) > seq && this.matches(e, projectId, threadId)
      );
  }
  matches(event: ConsoleEvent, projectId: string, threadId: string): boolean {
    return (
      event.type === "connection" ||
      event.type === "reset" ||
      event.type === "limits" ||
      (event.projectId === projectId &&
        (event.threadId === threadId || (!event.threadId && event.type === "status")))
    );
  }
  subscribe(listener: (event: ConsoleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  reset(reason: string): void {
    this.events = [];
    this.bytes = 0;
    this.publish({ type: "reset", payload: { reason } });
  }
  get retainedBytes(): number {
    return this.bytes;
  }
}
