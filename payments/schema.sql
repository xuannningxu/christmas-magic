CREATE TABLE IF NOT EXISTS export_orders (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  proof TEXT NOT NULL,
  capture_id TEXT UNIQUE,
  exported INTEGER NOT NULL DEFAULT 0 CHECK (exported IN (0,1))
);
