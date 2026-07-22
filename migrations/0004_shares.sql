-- 一鍵分享牌組:一份分享 = 一個隨機 code,內容是去除排程的純單字列
CREATE TABLE shares (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,   -- JSON: [{expression, reading, meaning, accent}]
  created_at INTEGER NOT NULL
);
