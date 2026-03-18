const API_BASE = '/api';
export const SOCKET_BASE = import.meta.env.VITE_SOCKET_URL || 'http://130.94.33.164:8081';

/**
 * 上传单个文件到服务器，并支持上传进度回调
 * @param {File} file
 * @param {{ onProgress?: (percent: number) => void }} [options]
 * @returns {Promise<{originalName: string, savedName: string, size: number, downloadUrl: string}>}
 */
export function uploadFile(file, options = {}) {
  const { onProgress } = options;
  const formData = new FormData();
  formData.append('files', file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/upload`);

    xhr.upload.addEventListener('progress', (event) => {
      if (!onProgress || !event.lengthComputable) {
        return;
      }

      const percent = Math.round((event.loaded / event.total) * 100);
      onProgress(percent);
    });

    xhr.addEventListener('load', () => {
      let payload = null;

      try {
        payload = JSON.parse(xhr.responseText);
      } catch (_) {
        payload = null;
      }

      if (xhr.status >= 200 && xhr.status < 300 && payload?.files?.[0]) {
        resolve(payload.files[0]);
        return;
      }

      reject(new Error(payload?.error || '上传失败'));
    });

    xhr.addEventListener('error', () => {
      reject(new Error('上传失败'));
    });

    xhr.addEventListener('abort', () => {
      reject(new Error('上传已取消'));
    });

    xhr.send(formData);
  });
}

/**
 * 保存配置到后端队列
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
 * 查询最老配置（只读，不删除）
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
export async function getBranches(repoId = '') {
  const query = repoId ? `?repoId=${encodeURIComponent(repoId)}` : '';
  const res = await fetch(`${API_BASE}/branches${query}`);

  if (!res.ok) {
    throw new Error('获取分支失败');
  }

  return res.json();
}

/**
 * 获取仓库配置及拉取状态列表
 */
export async function getGitRepos() {
  const res = await fetch(`${API_BASE}/git-repos`);

  if (!res.ok) {
    throw new Error('获取仓库列表失败');
  }

  return res.json();
}

/**
 * 新增仓库配置
 * @param {{name: string, repoUrl: string, username: string, password: string}} payload
 */
export async function createGitRepo(payload) {
  const res = await fetch(`${API_BASE}/git-repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }

  if (!res.ok) {
    throw new Error(data?.error || '保存仓库失败');
  }

  return data;
}

/**
 * 获取某个 room 的构建日志历史
 * @param {string} roomId
 */
export async function getBuildLogs(roomId) {
  const res = await fetch(`${API_BASE}/build-logs/${encodeURIComponent(roomId)}`);

  if (!res.ok) {
    throw new Error('获取构建日志失败');
  }

  return res.json();
}

/**
 * 获取已完成构建产物列表
 */
export async function getBuildArtifacts() {
  const res = await fetch(`${API_BASE}/build-artifacts`);

  if (!res.ok) {
    throw new Error('获取打包产物失败');
  }

  return res.json();
}
