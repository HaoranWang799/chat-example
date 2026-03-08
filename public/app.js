let socket = null;
let currentUser = null;
let selectedFriend = null;
let counter = 0;
let messages = [];
let friends = [];
let profiles = {};

const authCard = document.getElementById('auth-card');
const chatCard = document.getElementById('chat-card');
const authForm = document.getElementById('auth-form');
const registerBtn = document.getElementById('register-btn');
const authStatus = document.getElementById('auth-status');
const pendingList = document.getElementById('pending-list');
const friendList = document.getElementById('friend-list');
const friendInput = document.getElementById('friend-input');
const friendBtn = document.getElementById('friend-btn');
const titleEl = document.getElementById('conversation-title');
const messagesEl = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

function showChat() {
  authCard.classList.add('hidden');
  chatCard.classList.remove('hidden');
}

function renderMessages() {
  messagesEl.innerHTML = '';
  if (!currentUser || !selectedFriend) return;

  const list = messages.filter((m) => {
    return (m.senderId === currentUser.id && m.receiverId === selectedFriend.id)
      || (m.senderId === selectedFriend.id && m.receiverId === currentUser.id);
  });

  for (const msg of list) {
    const li = document.createElement('li');
    if (msg.senderId === currentUser.id) li.className = 'me';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msg.content;
    li.appendChild(bubble);
    messagesEl.appendChild(li);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadMessages() {
  if (!currentUser || !selectedFriend) return;
  const res = await fetch(`/api/messages?userId=${currentUser.id}&friendId=${selectedFriend.id}`);
  if (!res.ok) return;
  messages = await res.json();
  renderMessages();
}

function connectSocket() {
  socket?.disconnect();
  socket = io({ auth: { userId: currentUser.id, serverOffset: 0 } });
  socket.on('chat message', (msg) => {
    if (!messages.some((m) => m.id === msg.id)) {
      messages.push(msg);
    }
    renderMessages();
  });
}

async function fetchProfile(id) {
  if (profiles[id]) return profiles[id];
  const res = await fetch(`/api/users/${id}`);
  if (!res.ok) return null;
  profiles[id] = await res.json();
  return profiles[id];
}

async function loadFriends() {
  const res = await fetch(`/api/friends?userId=${currentUser.id}`);
  if (!res.ok) return;
  friends = await res.json();
  for (const f of friends) await fetchProfile(f.id);
  renderFriends();
}

function renderFriends() {
  friendList.innerHTML = '';
  for (const f of friends) {
    const p = profiles[f.id] || { id: f.id, username: `User ${f.id}` };
    const li = document.createElement('li');
    li.textContent = `${p.username} (#${p.id})`;
    if (selectedFriend?.id === f.id) li.classList.add('active');
    li.onclick = async () => {
      selectedFriend = p;
      titleEl.textContent = `${p.username} (#${p.id})`;
      renderFriends();
      await loadMessages();
    };
    friendList.appendChild(li);
  }
}

async function loadPending() {
  const res = await fetch(`/api/friends/pending?userId=${currentUser.id}`);
  if (!res.ok) return;
  const pending = await res.json();

  pendingList.innerHTML = '';
  for (const item of pending) {
    const p = await fetchProfile(item.id);
    const li = document.createElement('li');
    li.textContent = `${p?.username || `User ${item.id}`} (#${item.id})`;

    const btn = document.createElement('button');
    btn.textContent = '接受';
    btn.onclick = async () => {
      await fetch('/api/friends/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, friendId: item.id })
      });
      await Promise.all([loadFriends(), loadPending()]);
    };

    li.appendChild(btn);
    pendingList.appendChild(li);
  }
}

async function loginOrRegister(mode) {
  const email = document.getElementById('email').value.trim();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  const body = mode === 'register' ? { email, password, username } : { email, password };

  const res = await fetch(mode === 'register' ? '/api/register' : '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'request failed' }));
    authStatus.textContent = err.error || 'request failed';
    return;
  }

  currentUser = await res.json();
  authStatus.textContent = '';
  showChat();
  connectSocket();
  await Promise.all([loadFriends(), loadPending()]);
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await loginOrRegister('login');
});

registerBtn.addEventListener('click', async () => {
  await loginOrRegister('register');
});

friendBtn.addEventListener('click', async () => {
  const raw = friendInput.value.trim();
  if (!raw) return;

  let targetId = Number(raw);
  if (!Number.isInteger(targetId)) {
    const res = await fetch(`/api/users/by-username/${encodeURIComponent(raw)}`);
    if (!res.ok) return;
    const user = await res.json();
    targetId = user.id;
  }

  await fetch('/api/friends/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: currentUser.id, friendId: targetId })
  });

  friendInput.value = '';
});

messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!socket || !selectedFriend) return;

  const content = messageInput.value.trim();
  if (!content) return;

  const clientOffset = `${socket.id}-${counter++}`;
  socket.emit('chat message', {
    content,
    senderId: currentUser.id,
    receiverId: selectedFriend.id
  }, clientOffset, () => {});

  messageInput.value = '';
});