const express = require('express');

const router = express.Router();

const MAX_LOG_LINES_PER_ROOM = 2000;
const roomLogs = new Map();

function appendRoomLog(roomId, entry) {
  if (!roomLogs.has(roomId)) {
    roomLogs.set(roomId, []);
  }

  const logs = roomLogs.get(roomId);
  logs.push(entry);

  if (logs.length > MAX_LOG_LINES_PER_ROOM) {
    logs.splice(0, logs.length - MAX_LOG_LINES_PER_ROOM);
  }
}

// POST /api/build-logs - 接收 runner 上传的构建日志并推送到 socket room
router.post('/', (req, res) => {
  const {
    roomId,
    message,
    level = 'info',
    timestamp = new Date().toISOString(),
    done = false,
    status = ''
  } = req.body || {};

  const normalizedRoomId = String(roomId || '').trim();
  const normalizedMessage = String(message || '').trimEnd();

  if (!normalizedRoomId) {
    return res.status(400).json({ error: '缺少 roomId 参数' });
  }

  if (!normalizedMessage && !done) {
    return res.status(400).json({ error: '缺少 message 参数' });
  }

  const payload = {
    roomId: normalizedRoomId,
    message: normalizedMessage,
    level: String(level || 'info'),
    timestamp,
    done: Boolean(done),
    status: String(status || '')
  };

  appendRoomLog(normalizedRoomId, payload);

  const io = req.app.get('io');
  if (io) {
    io.to(normalizedRoomId).emit('build-log', payload);
  }

  res.json({ message: '日志已接收' });
});

// GET /api/build-logs/:roomId - 返回房间历史日志
router.get('/:roomId', (req, res) => {
  const normalizedRoomId = String(req.params.roomId || '').trim();
  if (!normalizedRoomId) {
    return res.status(400).json({ error: '缺少 roomId 参数' });
  }

  const logs = roomLogs.get(normalizedRoomId) || [];
  res.json({ roomId: normalizedRoomId, logs });
});

module.exports = router;
