CREATE TABLE IF NOT EXISTS ai_chat_challenges (
  challenge_id TEXT PRIMARY KEY,
  answer_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
