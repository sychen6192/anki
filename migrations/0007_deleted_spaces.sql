-- 刪除過的同步空間(設定頁「刪除雲端資料」):只存金鑰的 SHA-256,不存金鑰本身。
-- 之後拿這組金鑰同步一律回 410:還在用它的其他裝置才會停下來,不會把手上的資料又推回雲端。
CREATE TABLE deleted_spaces (
  space_hash TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
