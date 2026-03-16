const express = require('express');

const router = express.Router();

// 内存中存储分支列表
let branches = [];

// POST /api/branches - 上报客户端项目支持的分支
router.post('/', (req, res) => {
  const { branches: branchList } = req.body;

  console.log('Received branches:', req.body);

  if (!Array.isArray(branchList) || branchList.length === 0) {
    return res.status(400).json({ error: '请提供 branches 数组' });
  }

  branches = branchList.map(b => String(b).trim()).filter(Boolean);
  res.json({ message: '分支列表已更新', count: branches.length });
});

// GET /api/branches - 查询可用分支
router.get('/', (_req, res) => {
  res.json({ branches });
});

module.exports = router;
