ALTER TABLE notes ADD COLUMN accent TEXT NOT NULL DEFAULT '';

CREATE TABLE accent_dict (
  expression TEXT NOT NULL,
  reading    TEXT NOT NULL,
  pitch      TEXT NOT NULL,
  PRIMARY KEY (expression, reading)
);
CREATE INDEX idx_accent_dict_reading ON accent_dict(reading);
