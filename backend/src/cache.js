// 简单的内存缓存
let cachedConfig = null;

function setConfig(config) {
  cachedConfig = config;
}

function getConfig() {
  return cachedConfig;
}

function clearConfig() {
  cachedConfig = null;
}

module.exports = { setConfig, getConfig, clearConfig };
