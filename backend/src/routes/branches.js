const express = require('express');

const router = express.Router();

// 内存中存储分支列表，按仓库维度隔离
const branchesByRepo = new Map();

function normalizeRepoId(value) {
  const normalized = String(value || '').trim();
  return normalized || 'default';
}

// POST /api/branches - 上报客户端项目支持的分支
router.post('/', (req, res) => {
  const { branches: branchList, repoId, repoName } = req.body || {};

  console.log('Received branches:', req.body);

  if (!Array.isArray(branchList) || branchList.length === 0) {
    return res.status(400).json({ error: '请提供 branches 数组' });
  }

  const key = normalizeRepoId(repoId);
  const branches = branchList.map(b => String(b).trim()).filter(Boolean);
  branchesByRepo.set(key, {
    repoId: key,
    repoName: String(repoName || '').trim(),
    branches,
    updatedAt: new Date().toISOString()
  });

  res.json({ message: '分支列表已更新', repoId: key, count: branches.length });
});

// GET /api/branches - 查询某个仓库的可用分支
router.get('/', (req, res) => {
  const key = normalizeRepoId(req.query.repoId);
  const payload = branchesByRepo.get(key) || { repoId: key, repoName: '', branches: [], updatedAt: '' };

  res.json(payload);
});

module.exports = router;
