import Database from "better-sqlite3";
import { DB_FILE, ALWAYS_PRIORITY } from "./config.js";

export const DB = new Database(DB_FILE);
DB.pragma("journal_mode = WAL");
DB.pragma("busy_timeout = 5000");
DB.pragma("synchronous = NORMAL");
DB.exec(`
CREATE TABLE IF NOT EXISTS items(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, rarity TEXT, icon TEXT
);
CREATE TABLE IF NOT EXISTS lots(
 item_id TEXT, lot_id TEXT, price INTEGER, amount INTEGER, created_at TEXT,
 raw TEXT, seen_at TEXT, PRIMARY KEY(item_id,lot_id)
);
CREATE TABLE IF NOT EXISTS price_observations(
 item_id TEXT, ts TEXT, min_price INTEGER, avg_price REAL, max_price INTEGER, lots INTEGER, sales INTEGER,
 PRIMARY KEY(item_id,ts)
);
CREATE TABLE IF NOT EXISTS sale_observations(
 item_id TEXT, sale_id TEXT, ts TEXT, price INTEGER, amount INTEGER, raw TEXT,
 PRIMARY KEY(item_id,sale_id)
);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS priority_items(
 id TEXT PRIMARY KEY, weight INTEGER NOT NULL DEFAULT 1, updated_at TEXT
);
`);

try { DB.exec("ALTER TABLE lots ADD COLUMN qlt INTEGER"); } catch {}
try { DB.exec("ALTER TABLE lots ADD COLUMN ptn INTEGER"); } catch {}
try { DB.exec("ALTER TABLE sale_observations ADD COLUMN qlt INTEGER"); } catch {}
try { DB.exec("ALTER TABLE sale_observations ADD COLUMN ptn INTEGER"); } catch {}

try {
  DB.exec("CREATE INDEX IF NOT EXISTS idx_lots_item_price ON lots(item_id, price)");
  DB.exec("CREATE INDEX IF NOT EXISTS idx_price_obs_item_ts ON price_observations(item_id, ts DESC)");
  DB.exec("CREATE INDEX IF NOT EXISTS idx_sale_obs_item_ts ON sale_observations(item_id, ts DESC)");
  DB.exec("CREATE INDEX IF NOT EXISTS idx_sale_obs_item_qlt ON sale_observations(item_id, qlt, ptn)");
} catch (e) { console.warn("index create:", e.message); }

try {
  const ups = DB.prepare("INSERT INTO priority_items(id,weight,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET weight=excluded.weight, updated_at=excluded.updated_at");
  const now = new Date().toISOString();
  for (const id of ALWAYS_PRIORITY) ups.run(id, 50, now);
} catch (e) { console.warn("priority seed:", e.message); }

export function walCheckpoint() {
  try { DB.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
}
