import type { Database } from "bun:sqlite";

export interface AlertKey {
  provider: string;
  account: string;
  limitId: string;
  threshold: number;
  epoch: string;
}

/** True if this exact (provider, account, limitId, threshold, epoch) alert
 * has already fired — prevents re-firing within the same window. */
export function alertAlreadyFired(db: Database, k: AlertKey): boolean {
  const row = db
    .query(
      `SELECT 1 FROM alert_state
       WHERE provider = ? AND account = ? AND limit_id = ? AND threshold = ? AND epoch = ?`,
    )
    .get(k.provider, k.account, k.limitId, k.threshold, k.epoch);
  return row !== null;
}

export function markAlertFired(db: Database, k: AlertKey, firedAtMs: number): void {
  db.query(
    `INSERT OR IGNORE INTO alert_state(provider, account, limit_id, threshold, epoch, fired_at_ms)
     VALUES (?,?,?,?,?,?)`,
  ).run(k.provider, k.account, k.limitId, k.threshold, k.epoch, firedAtMs);
}
