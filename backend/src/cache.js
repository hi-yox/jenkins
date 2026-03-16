// 简单的内存队列，按提交顺序保存配置
const configQueue = [];

function enqueueConfig(config) {
  configQueue.push(config);
}

function peekConfig() {
  return configQueue[0] || null;
}

function shiftConfig() {
  return configQueue.shift() || null;
}

function getConfigCount() {
  return configQueue.length;
}

module.exports = { enqueueConfig, peekConfig, shiftConfig, getConfigCount };
