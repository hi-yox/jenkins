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

server.listen(PORT, () => {
  console.log(`Build Config Server running on http://localhost:${PORT}`);
});
