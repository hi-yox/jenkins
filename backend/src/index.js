const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const uploadRouter = require('./routes/upload');
const configRouter = require('./routes/config');
const branchesRouter = require('./routes/branches');

const app = express();
const PORT = process.env.PORT || 3001;

// 确保上传目录存在
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(cors());
app.use(express.json());

// 静态文件服务，提供上传文件的下载
app.use('/downloads', express.static(uploadsDir));

// 路由
app.use('/api/upload', uploadRouter);
app.use('/api/config', configRouter);
app.use('/api/branches', branchesRouter);

app.listen(PORT, () => {
  console.log(`Build Config Server running on http://localhost:${PORT}`);
});
