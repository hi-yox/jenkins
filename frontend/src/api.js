const API_BASE = '/api';

/**
 * 上传文件到服务器
 * @param {File[]} files
 * @returns {Promise<{files: Array<{originalName: string, savedName: string, size: number, downloadUrl: string}>}>}
 */
export async function uploadFiles(files) {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }

  const res = await fetch(`${API_BASE}/upload`, {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || '上传失败');
  }

  return res.json();
}

/**
 * 保存配置到后端缓存
 * @param {object} config
 */
export async function saveConfig(config) {
  const res = await fetch(`${API_BASE}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || '保存失败');
  }

  return res.json();
}

/**
 * 查询配置（查询后后端会清空）
 */
export async function getConfig() {
  const res = await fetch(`${API_BASE}/config`);

  if (!res.ok) {
    throw new Error('查询失败');
  }

  return res.json();
}

/**
 * 获取可用分支列表
 */
export async function getBranches() {
  const res = await fetch(`${API_BASE}/branches`);

  if (!res.ok) {
    throw new Error('获取分支失败');
  }

  return res.json();
}
