# Chat Example (Refactored)

## Run locally

```bash
npm install
npm start
```

Server starts at `http://localhost:8080` by default.

## Project structure

- `src/server.js`: Express API + Socket.IO server
- `src/db.js`: SQLite schema and conversation helper
- `public/index.html`: UI shell
- `public/style.css`: styles
- `public/app.js`: frontend logic

## Deployment (Railway)

1. Push latest code to GitHub.
2. In Railway project, trigger redeploy from latest commit.
3. Ensure `PORT` is provided by Railway (already handled in code).
4. Optional health check path: `/health`.