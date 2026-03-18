const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const reposFile = path.join(__dirname, '..', '..', 'uploads', 'git-repos.json');
const ALLOWED_STATUS = new Set(['pending', 'cloning', 'ready', 'failed']);

function ensureReposFile() {
  const dir = path.dirname(reposFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(reposFile)) {
    fs.writeFileSync(reposFile, '[]\n');
  }
}

function readRepos() {
  ensureReposFile();

  try {
    const raw = fs.readFileSync(reposFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeRepos(items) {
  ensureReposFile();
  fs.writeFileSync(reposFile, JSON.stringify(items, null, 2) + '\n');
}

function normalizeStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (ALLOWED_STATUS.has(normalized)) {
    return normalized;
  }
  return 'pending';
}

// GET /api/git-repos - 查询仓库配置列表
router.get('/', (_req, res) => {
  const items = readRepos().map((item) => ({
    ...item,
    status: normalizeStatus(item.status)
  }));

  res.json({ items, count: items.length });
});

// POST /api/git-repos - 新增仓库配置
router.post('/', (req, res) => {
  const payload = req.body || {};
  const repoUrl = String(payload.repoUrl || '').trim();
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '').trim();
  const name = String(payload.name || '').trim();

  if (!repoUrl) {
    return res.status(400).json({ error: '缺少 repoUrl 参数' });
  }

  if (!username) {
    return res.status(400).json({ error: '缺少 username 参数' });
  }

  if (!password) {
    return res.status(400).json({ error: '缺少 password 参数' });
  }

  const items = readRepos();
  const existed = items.find(
    (item) => String(item.repoUrl || '').trim() === repoUrl && String(item.username || '').trim() === username
  );

  if (existed) {
    return res.status(409).json({ error: '该仓库账号已存在，请勿重复添加', item: existed });
  }

  const now = new Date().toISOString();
  const record = {
    id: payload.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name || repoUrl,
    repoUrl,
    username,
    password,
    status: 'pending',
    localPath: '',
    lastError: '',
    createdAt: now,
    updatedAt: now
  };

  items.push(record);
  writeRepos(items);

  res.json({ message: '仓库配置已保存', item: record, count: items.length });
});

// PATCH /api/git-repos/:id/status - runner 更新仓库拉取状态
router.patch('/:id/status', (req, res) => {
  const repoId = String(req.params.id || '').trim();
  const payload = req.body || {};

  if (!repoId) {
    return res.status(400).json({ error: '缺少仓库 ID' });
  }

  const items = readRepos();
  const index = items.findIndex((item) => String(item.id || '') === repoId);

  if (index < 0) {
    return res.status(404).json({ error: '仓库配置不存在' });
  }

  const current = items[index];
  const nextStatus = payload.status ? normalizeStatus(payload.status) : normalizeStatus(current.status);

  const updated = {
    ...current,
    status: nextStatus,
    localPath: payload.localPath !== undefined ? String(payload.localPath || '') : current.localPath,
    lastError: payload.lastError !== undefined ? String(payload.lastError || '') : current.lastError,
    updatedAt: new Date().toISOString()
  };

  items[index] = updated;
  writeRepos(items);

  res.json({ message: '仓库状态已更新', item: updated });
});

module.exports = router;
