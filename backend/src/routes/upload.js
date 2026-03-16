const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

const uploadsDir = path.join(__dirname, '..', '..', 'uploads');

// 允许的文件类型
const ALLOWED_EXTENSIONS = new Set([
  '.zip', '.png', '.jpg', '.jpeg',
  '.mobileprovision', '.json', '.p12', '.cer', '.pem'
]);

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${uuidv4()}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error(`不允许的文件类型: ${ext}`));
    }
    cb(null, true);
  }
});

// POST /api/upload - 上传文件（支持多文件）
router.post('/', upload.array('files', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '没有上传文件' });
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const results = req.files.map(file => ({
    originalName: file.originalname,
    savedName: file.filename,
    size: file.size,
    downloadUrl: `${baseUrl}/downloads/${file.filename}`
  }));

  res.json({ files: results });
});

// 错误处理
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `上传错误: ${err.message}` });
  }
  res.status(400).json({ error: err.message });
});

module.exports = router;
