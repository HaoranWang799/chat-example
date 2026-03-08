import crypto from 'node:crypto';
import express from 'express';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { createDatabase, getOrCreateConversationId } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const app = express();
const server = createServer(app);
const io = new Server(server, { connectionStateRecovery: {} });
const db = await createDatabase(join(rootDir, 'chat.db'));

const userSockets = new Map();

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

app.use(express.json());
app.use(express.static(join(rootDir, 'public')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

app.post('/api/register', async (req, res) => {
  const { email, password, username } = req.body || {};

  if (!email || !password || !username) {
    return res.status(400).json({ error: 'email, password, username are required' });
  }

  try {
    const avatar = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(username)}`;
    const result = await db.run(
      'INSERT INTO users (email, password_hash, username, avatar) VALUES (?, ?, ?, ?)',
      email.trim(),
      hashPassword(password),
      username.trim(),
      avatar
    );

    return res.status(201).json({ id: result.lastID, email, username, avatar });
  } catch (err) {
    if (err?.errno === 19) {
      return res.status(409).json({ error: 'email or username already exists' });
    }
    console.error('register error', err);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const user = await db.get(
    'SELECT id, email, username, avatar, password_hash FROM users WHERE email = ?',
    email.trim()
  );

  if (!user || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'invalid email or password' });
  }

  return res.json({
    id: user.id,
    email: user.email,
    username: user.username,
    avatar: user.avatar
  });
});

app.get('/api/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid user id' });

  const user = await db.get('SELECT id, email, username, avatar FROM users WHERE id = ?', id);
  if (!user) return res.status(404).json({ error: 'user not found' });

  return res.json(user);
});

app.get('/api/users/by-username/:username', async (req, res) => {
  const username = String(req.params.username || '').trim();
  if (!username) return res.status(400).json({ error: 'username is required' });

  const user = await db.get(
    'SELECT id, email, username, avatar FROM users WHERE username = ?',
    username
  );

  if (!user) return res.status(404).json({ error: 'user not found' });
  return res.json(user);
});

app.post('/api/friends/request', async (req, res) => {
  const userId = Number(req.body?.userId);
  const friendId = Number(req.body?.friendId);

  if (!Number.isInteger(userId) || !Number.isInteger(friendId)) {
    return res.status(400).json({ error: 'userId and friendId are required' });
  }
  if (userId === friendId) return res.status(400).json({ error: 'cannot add self' });

  try {
    await db.run(
      'INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)',
      userId,
      friendId,
      'pending'
    );
    return res.status(201).json({ userId, friendId, status: 'pending' });
  } catch (err) {
    if (err?.errno === 19) {
      return res.status(409).json({ error: 'friend request already exists' });
    }
    console.error('friend request error', err);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/api/friends/accept', async (req, res) => {
  const userId = Number(req.body?.userId);
  const friendId = Number(req.body?.friendId);

  if (!Number.isInteger(userId) || !Number.isInteger(friendId)) {
    return res.status(400).json({ error: 'userId and friendId are required' });
  }

  await db.run(
    'UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?',
    'accepted',
    friendId,
    userId
  );

  await db.run(
    `INSERT INTO friends (user_id, friend_id, status)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, friend_id) DO UPDATE SET status = excluded.status`,
    userId,
    friendId,
    'accepted'
  );

  return res.json({ userId, friendId, status: 'accepted' });
});

app.get('/api/friends', async (req, res) => {
  const userId = Number(req.query.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'invalid userId' });

  const rows = await db.all(
    'SELECT friend_id AS id, status FROM friends WHERE user_id = ? AND status = ?',
    userId,
    'accepted'
  );

  return res.json(rows);
});

app.get('/api/friends/pending', async (req, res) => {
  const userId = Number(req.query.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'invalid userId' });

  const rows = await db.all(
    'SELECT user_id AS id FROM friends WHERE friend_id = ? AND status = ?',
    userId,
    'pending'
  );

  return res.json(rows);
});

app.get('/api/messages', async (req, res) => {
  const userId = Number(req.query.userId);
  const friendId = Number(req.query.friendId);

  if (!Number.isInteger(userId) || !Number.isInteger(friendId)) {
    return res.status(400).json({ error: 'invalid userId/friendId' });
  }

  const conversationId = await getOrCreateConversationId(db, userId, friendId);
  if (!conversationId) return res.json([]);

  const rows = await db.all(
    `SELECT id, content, sender_id AS senderId, receiver_id AS receiverId
     FROM messages
     WHERE conversation_id = ?
     ORDER BY id ASC`,
    conversationId
  );

  return res.json(rows);
});

app.get('/api/online-status', (req, res) => {
  const raw = String(req.query.userIds || '').trim();
  if (!raw) return res.status(400).json({ error: 'missing userIds' });

  const status = {};
  for (const token of raw.split(',')) {
    const id = Number(token.trim());
    if (Number.isInteger(id)) {
      status[String(id)] = userSockets.has(id);
    }
  }
  return res.json(status);
});

io.on('connection', (socket) => {
  const authUserId = Number(socket.handshake?.auth?.userId);
  const userId = Number.isInteger(authUserId) ? authUserId : null;

  if (userId != null) {
    userSockets.set(userId, socket.id);
  }

  socket.on('disconnect', () => {
    if (userId != null && userSockets.get(userId) === socket.id) {
      userSockets.delete(userId);
    }
  });

  socket.on('chat message', async (payload, clientOffset, callback) => {
    try {
      const content = String(payload?.content || '').trim();
      const receiverId = Number(payload?.receiverId);
      const senderId = Number.isInteger(userId) ? userId : Number(payload?.senderId);

      if (!content || !Number.isInteger(senderId) || !Number.isInteger(receiverId)) {
        callback?.({ ok: false, error: 'invalid payload' });
        return;
      }

      const conversationId = await getOrCreateConversationId(db, senderId, receiverId);

      const result = await db.run(
        `INSERT INTO messages (content, client_offset, sender_id, receiver_id, conversation_id)
         VALUES (?, ?, ?, ?, ?)`,
        content,
        clientOffset ?? null,
        senderId,
        receiverId,
        conversationId
      );

      const eventPayload = {
        id: result.lastID,
        content,
        senderId,
        receiverId
      };

      const receiverSocket = userSockets.get(receiverId);
      if (receiverSocket) {
        io.to(receiverSocket).emit('chat message', eventPayload, result.lastID);
      }

      socket.emit('chat message', eventPayload, result.lastID);
      callback?.({ ok: true, id: result.lastID });
    } catch (err) {
      if (err?.errno === 19) {
        callback?.({ ok: true });
        return;
      }
      console.error('socket message error', err);
      callback?.({ ok: false, error: 'server error' });
    }
  });
});

const port = Number(process.env.PORT) || 8080;
server.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});