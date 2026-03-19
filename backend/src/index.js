const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const uploadRouter = require('./routes/upload');
const configRouter = require('./routes/config');
const branchesRouter = require('./routes/branches');
const buildLogsRouter = require('./routes/build-logs');
const buildArtifactsRouter = require('./routes/build-artifacts');
const gitReposRouter = require('./routes/git-repos');

const app = express();
const PORT = process.env.PORT || 8081;
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => {
    const normalizedRoomId = String(roomId || '').trim();
    if (!normalizedRoomId) {
      return;
    }

    socket.join(normalizedRoomId);
  });
});

// 确保上传目录存在
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  console.log(`[HTTP] [${requestId}] -> ${req.method} ${req.originalUrl}`);

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    console.log(`[HTTP] [${requestId}] <- ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
  });

  next();
});

app.use(cors());
app.use(express.json());
app.set('io', io);

// 静态文件服务，提供上传文件的下载
app.use('/downloads', express.static(uploadsDir));

// 路由
app.use('/api/upload', uploadRouter);
app.use('/api/config', configRouter);
app.use('/api/branches', branchesRouter);
app.use('/api/build-logs', buildLogsRouter);
app.use('/api/build-artifacts', buildArtifactsRouter);
app.use('/api/git-repos', gitReposRouter);

app.use((err, req, res, _next) => {
  console.error(`[HTTP] ${req.method} ${req.originalUrl} 未处理异常:`, err);

  if (res.headersSent) {
    return;
  }

  res.status(500).json({ error: '服务器内部错误' });
});

server.on('clientError', (error, socket) => {
  console.error('[HTTP] clientError:', error.message);
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

process.on('uncaughtException', (error) => {
  console.error('[Process] uncaughtException:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process] unhandledRejection:', reason);
});

server.listen(PORT, () => {
  console.log(`Build Config Server running on http://localhost:${PORT}`);
});
