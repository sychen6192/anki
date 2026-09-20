-- 使用者層級設定(FSRS 參數、目標保持率):與四張同步表同一套 LWW + namespace + server_seq
CREATE TABLE settings (
  id TEXT PRIMARY KEY, value TEXT NOT NULL,
  updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  namespace TEXT NOT NULL DEFAULT '',
  server_seq INTEGER NOT NULL
);
CREATE INDEX idx_settings_ns_seq ON settings(namespace, server_seq);
