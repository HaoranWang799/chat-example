import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import crypto from 'node:crypto';

const db = await open({
  filename: 'chat.db',
  driver: sqlite3.Database
});

await db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_offset TEXT UNIQUE,
    content TEXT,
    sender_id INTEGER,
    receiver_id INTEGER,
    conversation_id INTEGER
  );
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user1_id INTEGER NOT NULL,
    user2_id INTEGER NOT NULL,
    UNIQUE(user1_id, user2_id)
  );
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS message_reads (
    conversation_id INTEGER,
    user_id INTEGER,
    last_read_message_id INTEGER,
    PRIMARY KEY (conversation_id, user_id)
  );
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    status TEXT NOT NULL
  );
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    username TEXT UNIQUE,
    avatar TEXT
  );
`);

try {
  await db.exec('ALTER TABLE messages ADD COLUMN sender_id INTEGER;');
} catch (e) {
  // ignore if column already exists
}

try {
  await db.exec('ALTER TABLE messages ADD COLUMN receiver_id INTEGER;');
} catch (e) {
  // ignore if column already exists
}

try {
  await db.exec('ALTER TABLE messages ADD COLUMN conversation_id INTEGER;');
} catch (e) {
  // ignore if column already exists
}

await db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);');
await db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user1 ON conversations(user1_id);');
await db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user2 ON conversations(user2_id);');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  connectionStateRecovery: {}
});

const __dirname = dirname(fileURLToPath(import.meta.url));

const hashPassword = (password) => {
  return crypto.createHash('sha256').update(password).digest('hex');
};

app.use(express.json());
app.use(express.static(__dirname));

const userSockets = new Map();

const getOrCreateConversationId = async (userA, userB) => {
  if (userA == null || userB == null) {
    return null;
  }

  const a = Math.min(userA, userB);
  const b = Math.max(userA, userB);

  let row = await db.get(
    'SELECT id FROM conversations WHERE user1_id = ? AND user2_id = ?',
    a,
    b
  );

  if (row && row.id != null) {
    return row.id;
  }

  try {
    const result = await db.run(
      'INSERT INTO conversations (user1_id, user2_id) VALUES (?, ?)',
      a,
      b
    );
    return result.lastID;
  } catch (e) {
    // handle potential UNIQUE constraint race by re-reading
    if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
      row = await db.get(
        'SELECT id FROM conversations WHERE user1_id = ? AND user2_id = ?',
        a,
        b
      );
      return row ? row.id : null;
    }
    throw e;
  }
};

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.post('/api/register', async (req, res) => {
  const { email, password, username } = req.body || {};

  if (!email || !password || !username) {
    return res.status(400).json({ error: 'Email, password, and username are required' });
  }

  if (email.trim().length === 0 || password.trim().length === 0 || username.trim().length === 0) {
    return res.status(400).json({ error: 'Email, password, and username cannot be empty' });
  }

  try {
    const avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(username)}`;
    const result = await db.run(
      'INSERT INTO users (email, passwordHash, username, avatar) VALUES (?, ?, ?, ?)',
      email,
      hashPassword(password),
      username,
      avatarUrl
    );

    return res.status(201).json({
      id: result.lastID,
      email,
      username,
      avatar: avatarUrl
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT' || err.errno === 19) {
      // Check which constraint failed
      if (err.message && err.message.includes('email')) {
        return res.status(409).json({ error: 'Email already registered' });
      }
      if (err.message && err.message.includes('username')) {
        return res.status(409).json({ error: 'Username already taken' });
      }
      // Generic constraint error
      return res.status(409).json({ error: 'Email or username already registered' });
    }
    console.error('Error registering user:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await db.get(
      'SELECT id, email, username, avatar, passwordHash FROM users WHERE email = ?',
      email
    );

    if (!user || user.passwordHash !== hashPassword(password)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    return res.json({
      id: user.id,
      email: user.email,
      username: user.username,
      avatar: user.avatar
    });
  } catch (err) {
    console.error('Error logging in user', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users/:id', async (req, res) => {
  const userId = Number(req.params.id);

  if (Number.isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }

  try {
    const user = await db.get(
      'SELECT id, email, username, avatar FROM users WHERE id = ?',
      userId
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ id: user.id, email: user.email, username: user.username, avatar: user.avatar });
  } catch (err) {
    console.error('Error fetching user profile', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users/by-username/:username', async (req, res) => {
  const { username } = req.params;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const user = await db.get(
      'SELECT id, username, avatar, email FROM users WHERE username = ?',
      username
    );

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ id: user.id, username: user.username, avatar: user.avatar, email: user.email });
  } catch (err) {
    console.error('Error fetching user by username', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/friends/request', async (req, res) => {
  const { userId, friendId } = req.body || {};

  if (!userId || !friendId) {
    return res.status(400).json({ error: 'userId and friendId are required' });
  }

  if (userId === friendId) {
    return res.status(400).json({ error: 'Cannot add yourself as a friend' });
  }

  try {
    await db.run(
      'INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)',
      userId,
      friendId,
      'pending'
    );
    return res.status(201).json({ userId, friendId, status: 'pending' });
  } catch (err) {
    console.error('Error sending friend request', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/friends/accept', async (req, res) => {
  const { userId, friendId } = req.body || {};

  if (!userId || !friendId) {
    return res.status(400).json({ error: 'userId and friendId are required' });
  }

  try {
    await db.run(
      'UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?',
      'accepted',
      friendId,
      userId
    );

    await db.run(
      'INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)',
      userId,
      friendId,
      'accepted'
    );

    return res.json({ userId, friendId, status: 'accepted' });
  } catch (err) {
    console.error('Error accepting friend request', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/friends', async (req, res) => {
  const rawUserId = req.query.userId;
  const userId = Number(rawUserId);

  if (!rawUserId || Number.isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid or missing userId' });
  }

  try {
    const friends = await db.all(
      'SELECT friend_id AS id, status FROM friends WHERE user_id = ? AND status = ?',
      userId,
      'accepted'
    );
    return res.json(friends || []);
  } catch (err) {
    console.error('Error fetching friends', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/friends/pending', async (req, res) => {
  const rawUserId = req.query.userId;
  const userId = Number(rawUserId);

  if (!rawUserId || Number.isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid or missing userId' });
  }

  try {
    const pending = await db.all(
      'SELECT user_id AS id FROM friends WHERE friend_id = ? AND status = ?',
      userId,
      'pending'
    );
    return res.json(pending || []);
  } catch (err) {
    console.error('Error fetching pending requests', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/conversations', async (req, res) => {
  const rawUserId = req.query.userId;
  const userId = Number(rawUserId);

  if (!rawUserId || Number.isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid or missing userId' });
  }

  try {
    const rows = await db.all(
      `
      SELECT
        c.id AS conversation_id,
        CASE
          WHEN c.user1_id = ? THEN c.user2_id
          ELSE c.user1_id
        END AS peer_id,
        m.content AS last_content,
        m.id AS last_message_id
      FROM conversations c
      LEFT JOIN messages m
        ON m.id = (
          SELECT MAX(id) FROM messages WHERE conversation_id = c.id
        )
      WHERE c.user1_id = ? OR c.user2_id = ?
      ORDER BY last_message_id DESC NULLS LAST, c.id ASC
      `,
      [userId, userId, userId]
    );

    const conversationsWithUnread = await Promise.all(
      rows.map(async (row) => {
        const readRow = await db.get(
          'SELECT last_read_message_id FROM message_reads WHERE conversation_id = ? AND user_id = ?',
          row.conversation_id,
          userId
        );

        const lastReadId = readRow && readRow.last_read_message_id != null
          ? readRow.last_read_message_id
          : 0;

        const unreadRow = await db.get(
          'SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND id > ? AND receiver_id = ?',
          row.conversation_id,
          lastReadId,
          userId
        );

        const unreadCount = unreadRow && typeof unreadRow.count === 'number'
          ? unreadRow.count
          : 0;

        return {
          conversationId: row.conversation_id,
          peerId: row.peer_id,
          lastMessage: row.last_content ?? null,
          lastMessageId: row.last_message_id ?? null,
          unreadCount
        };
      })
    );

    return res.json(conversationsWithUnread);
  } catch (err) {
    console.error('Error fetching conversations', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/conversations/:id/read', async (req, res) => {
  const conversationId = Number(req.params.id);
  const { userId: bodyUserId } = req.body || {};
  const userId = Number(bodyUserId);

  if (Number.isNaN(conversationId) || Number.isNaN(userId)) {
    return res.status(400).json({ error: 'Invalid conversation id or userId' });
  }

  try {
    const latest = await db.get(
      'SELECT MAX(id) AS max_id FROM messages WHERE conversation_id = ?',
      conversationId
    );

    const lastReadMessageId = latest && latest.max_id != null ? latest.max_id : 0;

    await db.run(
      `INSERT INTO message_reads (conversation_id, user_id, last_read_message_id)
       VALUES (?, ?, ?)
       ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id`,
      conversationId,
      userId,
      lastReadMessageId
    );

    return res.json({
      conversationId,
      userId,
      lastReadMessageId
    });
  } catch (err) {
    console.error('Error marking conversation as read', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/online-status', (req, res) => {
  const rawUserIds = req.query.userIds;

  if (!rawUserIds) {
    return res.status(400).json({ error: 'Missing userIds query parameter' });
  }

  const ids = String(rawUserIds)
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  const status = {};

  for (const idStr of ids) {
    const idNum = Number(idStr);
    if (Number.isNaN(idNum)) {
      status[idStr] = false;
    } else {
      status[String(idNum)] = userSockets.has(idNum);
    }
  }

  return res.json(status);
});

io.on('connection', async (socket) => {
  const auth = socket.handshake && socket.handshake.auth ? socket.handshake.auth : {};
  const userId = auth.userId != null ? auth.userId : null;

  if (userId != null) {
    userSockets.set(userId, socket.id);
  }

  socket.on('disconnect', () => {
    if (userId != null) {
      const current = userSockets.get(userId);
      if (current === socket.id) {
        userSockets.delete(userId);
      }
    }
  });

  socket.on('chat message', async (payload, clientOffset, callback) => {
    const { content, senderId, receiverId } = typeof payload === 'string'
      ? { content: payload, senderId: null, receiverId: null }
      : payload || {};

    if (!content) {
      return callback && callback();
    }

    let result;
    let conversationId = null;

    if (senderId != null && receiverId != null) {
      conversationId = await getOrCreateConversationId(senderId, receiverId);
    }

    try {
      result = await db.run(
        'INSERT INTO messages (content, client_offset, sender_id, receiver_id, conversation_id) VALUES (?, ?, ?, ?, ?)',
        content,
        clientOffset,
        senderId ?? null,
        receiverId ?? null,
        conversationId ?? null
      );
    } catch (e) {
      if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
        callback && callback();
      } else {
        // nothing to do, just let the client retry
      }
      return;
    }

    if (receiverId != null) {
      const targetSocketId = userSockets.get(receiverId);
      if (targetSocketId) {
        io.to(targetSocketId).emit(
          'chat message',
          { content, senderId: senderId ?? null, receiverId },
          result.lastID
        );
      }
    } else {
      io.emit(
        'chat message',
        { content, senderId: senderId ?? null, receiverId: null },
        result.lastID
      );
    }

    callback && callback();
  });

  if (!socket.recovered) {
    try {
      await db.each(
        'SELECT id, content, sender_id, receiver_id FROM messages WHERE id > ?',
        [socket.handshake.auth.serverOffset || 0],
        (_err, row) => {
          const isPrivate = row.receiver_id != null;

          if (isPrivate) {
            if (userId == null || row.receiver_id !== userId) {
              return;
            }
          }

          socket.emit(
            'chat message',
            {
              content: row.content,
              senderId: row.sender_id,
              receiverId: row.receiver_id
            },
            row.id
          );
        }
      );
    } catch (e) {
      // something went wrong
    }
  }
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
