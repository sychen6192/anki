-- 卡片狀態:0 學習中、1 暫停、2 已經會了(後兩者不進佇列)。舊列一律 0。
ALTER TABLE cards ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
