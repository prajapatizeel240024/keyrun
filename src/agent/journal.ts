// Append-only, fsync'd journal of idempotency keys on the device. Together with idempotent
// workflows it turns at-least-once delivery into effectively-once execution:
//   done     → a redelivered task is answered from the journal; the browser never opens
//   started  → the previous attempt died mid-run; workflows check the real state before acting,
//              and a rotation first checks whether the new password is already live
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

export type JournalResult = {
  status: 'succeeded' | 'noop' | 'failed';
  message: string;
  durationMs?: number;
  failure?: { reason: string; retryable: boolean; detail?: string };
  credentialVersion?: number;
};

/** A rotation's new password, sealed to this device's own key (never stored in the clear). */
export type PendingSecret = { ciphertext: string; nonce: string; sealedDek: string };

export type JournalEntry = {
  key: string;
  taskId: string;
  state: 'started' | 'done';
  attempt: number;
  at: string;
  result?: JournalResult;
  pending?: PendingSecret;
};

export class Journal {
  private entries = new Map<string, JournalEntry>();

  constructor(private file: string) {}

  static async open(home: string): Promise<Journal> {
    const j = new Journal(path.join(home, 'journal.jsonl'));
    await mkdir(home, { recursive: true, mode: 0o700 });
    try {
      for (const line of (await readFile(j.file, 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as JournalEntry;
          // Keep the latest entry per key, but never lose a pending secret recorded earlier.
          const prev = j.entries.get(e.key);
          j.entries.set(e.key, { ...e, pending: e.pending ?? prev?.pending });
        } catch {
          // A torn final line from a crash mid-write: ignore it.
        }
      }
    } catch {
      // No journal yet.
    }
    return j;
  }

  get(key: string): JournalEntry | undefined {
    return this.entries.get(key);
  }

  async write(entry: Omit<JournalEntry, 'at'>): Promise<void> {
    const full: JournalEntry = { ...entry, at: new Date().toISOString() };
    const fh = await open(this.file, 'a', 0o600);
    try {
      await fh.write(JSON.stringify(full) + '\n');
      await fh.datasync();
    } finally {
      await fh.close();
    }
    const prev = this.entries.get(entry.key);
    this.entries.set(entry.key, { ...full, pending: full.pending ?? prev?.pending });
  }
}
