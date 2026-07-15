ALTER TABLE decks ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
ALTER TABLE review_logs ADD COLUMN namespace TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_decks_ns_seq ON decks(namespace, server_seq);
CREATE INDEX idx_notes_ns_seq ON notes(namespace, server_seq);
CREATE INDEX idx_cards_ns_seq ON cards(namespace, server_seq);
CREATE INDEX idx_logs_ns_seq ON review_logs(namespace, server_seq);
