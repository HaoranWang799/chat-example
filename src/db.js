import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

export async function createDatabase(filename = 'chat.db') {
  const db = await open({ filename, driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      avatar TEXT
    );

    CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      UNIQUE(user_id, friend_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user1_id INTEGER NOT NULL,
      user2_id INTEGER NOT NULL,
      UNIQUE(user1_id, user2_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT NOT NULL,
      sender_id INTEGER,
      receiver_id INTEGER,
      conversation_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS message_reads (
      conversation_id INTEGER,
      user_id INTEGER,
      last_read_message_id INTEGER,
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_user1 ON conversations(user1_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_user2 ON conversations(user2_id);
  `);

  return db;
}

export async function getOrCreateConversationId(db, userA, userB) {
  if (userA == null || userB == null) return null;

  const a = Math.min(userA, userB);
  const b = Math.max(userA, userB);

  const row = await db.get(
    'SELECT id FROM conversations WHERE user1_id = ? AND user2_id = ?',
    a,
    b
  );

  if (row?.id) return row.id;

  try {
    const result = await db.run(
      'INSERT INTO conversations (user1_id, user2_id) VALUES (?, ?)',
      a,
      b
    );
    return result.lastID;
  } catch (err) {
    if (err?.errno === 19) {
      const existing = await db.get(
        'SELECT id FROM conversations WHERE user1_id = ? AND user2_id = ?',
        a,
        b
      );
      return existing?.id ?? null;
    }
    throw err;
  }
}