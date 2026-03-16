const express = require('express');
const { setConfig, getConfig, clearConfig } = require('../cache');

const router = express.Router();

// POST /api/config - 保存配置到缓存
router.post('/', (req, res) => {
  const config = req.body;

  // 校验必填字段
  if (!config.appName) {
    return res.status(400).json({ error: '缺少 appName 参数' });
  }

  setConfig({
    ...config,
    createdAt: new Date().toISOString()
  });

  res.json({ message: '配置已保存' });
});

// GET /api/config - 查询配置并清空
router.get('/', (_req, res) => {
  const config = getConfig();

  if (!config) {
    return res.json({ data: null, message: '暂无配置' });
  }

  // 返回后清空缓存
  clearConfig();

  res.json({ data: config, message: '配置已返回并清空' });
});

module.exports = router;
