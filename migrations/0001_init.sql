CREATE TABLE decks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, new_per_day INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL
);
CREATE TABLE notes (
  id TEXT PRIMARY KEY, deck_id TEXT NOT NULL, expression TEXT NOT NULL,
  reading TEXT NOT NULL DEFAULT '', meaning TEXT NOT NULL,
  reversed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL
);
CREATE TABLE cards (
  id TEXT PRIMARY KEY, note_id TEXT NOT NULL, deck_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  due INTEGER NOT NULL, stability REAL NOT NULL, difficulty REAL NOT NULL,
  elapsed_days REAL NOT NULL, scheduled_days REAL NOT NULL,
  learning_steps INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL, lapses INTEGER NOT NULL, state INTEGER NOT NULL,
  last_review INTEGER,
  updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL
);
CREATE TABLE review_logs (
  id TEXT PRIMARY KEY, card_id TEXT NOT NULL, rating INTEGER NOT NULL,
  state INTEGER NOT NULL, due INTEGER NOT NULL,
  stability REAL NOT NULL, difficulty REAL NOT NULL,
  elapsed_days REAL NOT NULL, last_elapsed_days REAL NOT NULL, scheduled_days REAL NOT NULL,
  reviewed_at INTEGER NOT NULL,
  server_seq INTEGER NOT NULL
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO meta (key, value) VALUES ('seq', 0);
CREATE INDEX idx_decks_seq ON decks(server_seq);
CREATE INDEX idx_notes_seq ON notes(server_seq);
CREATE INDEX idx_cards_seq ON cards(server_seq);
CREATE INDEX idx_logs_seq ON review_logs(server_seq);
