const express = require('express');
const { enqueueConfig, peekConfig, shiftConfig, getConfigCount } = require('../cache');

const router = express.Router();

// POST /api/config - 追加配置到队列
router.post('/', (req, res) => {
  const config = req.body || {};
  const appName = String(config.appName || '').trim();
  const repoId = String(config.repoId || '').trim();
  const repoName = String(config.repoName || '').trim();

  // 校验必填字段
  if (!appName) {
    return res.status(400).json({ error: '缺少 appName 参数' });
  }

  if (!repoId) {
    return res.status(400).json({ error: '缺少 repoId 参数，请先选择已拉取完成的仓库' });
  }

  enqueueConfig({
    ...config,
    appName,
    repoId,
    repoName,
    createdAt: new Date().toISOString()
  });

  res.json({ message: '配置已加入队列', queueLength: getConfigCount() });
});

// GET /api/config - 只读查询最老的配置，不删除
router.get('/', (_req, res) => {
  const config = peekConfig();

  if (!config) {
    return res.json({ data: null, message: '暂无配置', queueLength: 0 });
  }

  res.json({ data: config, message: '最老配置已返回（未删除）', queueLength: getConfigCount() });
});

// GET /api/config/consume - 供 runner 消费最老的配置，并从队列删除
router.get('/consume', (_req, res) => {
  const config = shiftConfig();

  if (!config) {
    return res.json({ data: null, message: '暂无配置', queueLength: 0 });
  }

  res.json({ data: config, message: '最老配置已返回并删除', queueLength: getConfigCount() });
});

module.exports = router;
