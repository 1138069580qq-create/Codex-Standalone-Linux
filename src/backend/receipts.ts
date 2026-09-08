import { promises as fs } from "fs";
import path from "path";
import { ConsoleError } from "./config";

/** Write-ahead command receipts. Ambiguous sends are never replayed after a restart. */
export class CommandReceipts {
  private records = new Map<string, { at: number; state: "pending" | "done"; result?: unknown }>();
  private flushing: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  async load(): Promise<void> {
    try {
      const rows = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (!Array.isArray(rows)) throw new Error("Invalid command receipt store");
      for (const [key, value] of rows) this.records.set(key, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async run<T>(key: string, action: (markSubmitted: () => void) => Promise<T>, options: { trackSubmission?: boolean } = {}): Promise<T> {
    const record = this.records.get(key);
    if (record?.state === "done") return record.result as T;
    if (record)
      throw new ConsoleError(
        409,
        "OUTCOME_UNKNOWN",
        "上次提交结果尚未确认。请先刷新任务核对消息，不要直接重发。"
      );
    if (this.records.size >= 10000)
      throw new ConsoleError(
        503,
        "RECEIPTS_FULL",
        "Command receipt retention limit reached; ask an administrator to archive receipts while disconnected."
      );
    this.records.set(key, { state: "pending", at: Date.now() });
    // Opt-in callers mark the dispatch boundary. Existing callers remain conservative.
    let submitted = options.trackSubmission !== true;
    try {
      await this.flush();
    } catch (error) {
      this.records.delete(key); // action has not been called
      throw error;
    }
    let result: T;
    try {
      result = await action(() => { submitted = true; });
    } catch (error) {
      if (!submitted) {
        this.records.delete(key);
        await this.flush();
      }
      throw error;
    }
    this.records.set(key, { state: "done", at: Date.now(), result });
    await this.flush();
    return result;
  }
  private flush(): Promise<void> {
    this.flushing = this.flushing
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        // Serialize writes; no conversation bodies or credentials are stored here.
        await fs.writeFile(this.file + ".tmp", JSON.stringify(Array.from(this.records)), {
          mode: 0o600
        });
        await fs.rename(this.file + ".tmp", this.file);
      });
    return this.flushing;
  }
}
