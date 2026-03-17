const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const artifactsFile = path.join(__dirname, '..', '..', 'uploads', 'build-artifacts.json');

function ensureArtifactsFile() {
  const dir = path.dirname(artifactsFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(artifactsFile)) {
    fs.writeFileSync(artifactsFile, '[]\n');
  }
}

function readArtifacts() {
  ensureArtifactsFile();

  try {
    const raw = fs.readFileSync(artifactsFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeArtifacts(artifacts) {
  ensureArtifactsFile();
  fs.writeFileSync(artifactsFile, JSON.stringify(artifacts, null, 2) + '\n');
}

// GET /api/build-artifacts - 返回已完成打包记录（默认按最新优先）
router.get('/', (req, res) => {
  const items = readArtifacts();
  const ordered = [...items].reverse();
  res.json({ items: ordered, count: ordered.length });
});

// POST /api/build-artifacts - 保存打包结果记录
router.post('/', (req, res) => {
  const payload = req.body || {};
  const downloadUrl = String(payload.downloadUrl || '').trim();

  if (!downloadUrl) {
    return res.status(400).json({ error: '缺少 downloadUrl 参数' });
  }

  const items = readArtifacts();
  const record = {
    id: payload.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: payload.createdAt || new Date().toISOString(),
    ...payload,
    downloadUrl
  };

  items.push(record);
  writeArtifacts(items);

  res.json({ message: '打包产物已保存', item: record, count: items.length });
});

module.exports = router;
