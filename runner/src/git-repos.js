const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function trimTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function sanitizeRepoFolderName(name) {
  return String(name || 'repo')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'repo';
}

function maskCredential(value) {
  return String(value || '').replace(/\/\/([^:@/]+):([^@/]+)@/g, '//***:***@');
}

function isGitRepo(localPath) {
  if (!localPath) {
    return false;
  }

  const gitDir = path.join(localPath, '.git');
  return fs.existsSync(gitDir);
}

function buildAuthRepoUrl(repoUrl, username, password) {
  try {
    const urlObj = new URL(repoUrl);
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return repoUrl;
    }

    urlObj.username = username;
    urlObj.password = password;
    return urlObj.toString();
  } catch (_) {
    return repoUrl;
  }
}

function resolveRepoLocalPath(reposRoot, repo) {
  const configured = String(repo.localPath || '').trim();
  if (configured) {
    return configured;
  }

  const safeName = sanitizeRepoFolderName(repo.name || repo.repoUrl || 'repo');
  const suffix = String(repo.id || '').slice(0, 8) || Date.now().toString(36);
  return path.join(reposRoot, `${safeName}-${suffix}`);
}

async function fetchGitRepos(apiBase) {
  const normalizedApiBase = trimTrailingSlash(apiBase);
  const res = await fetch(`${normalizedApiBase}/api/git-repos`);

  if (!res.ok) {
    throw new Error(`获取仓库配置失败: ${res.status}`);
  }

  const result = await res.json();
  return Array.isArray(result.items) ? result.items : [];
}

async function reportRepoStatus(apiBase, repoId, payload) {
  const normalizedApiBase = trimTrailingSlash(apiBase);
  const res = await fetch(`${normalizedApiBase}/api/git-repos/${encodeURIComponent(repoId)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`更新仓库状态失败: ${res.status} ${text}`);
  }

  return res.json();
}

function cloneRepo(repo, localPath) {
  const authUrl = buildAuthRepoUrl(repo.repoUrl, repo.username, repo.password);

  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  execFileSync('git', ['clone', '--origin', 'origin', authUrl, localPath], {
    stdio: 'pipe'
  });
}

async function syncGitRepos(apiBase, reposRoot, logger = console) {
  const repos = await fetchGitRepos(apiBase);
  const synced = [];

  for (const repo of repos) {
    const repoId = String(repo.id || '').trim();
    if (!repoId) {
      continue;
    }

    const localPath = resolveRepoLocalPath(reposRoot, repo);

    if (isGitRepo(localPath)) {
      if (repo.status !== 'ready' || repo.localPath !== localPath || repo.lastError) {
        await reportRepoStatus(apiBase, repoId, {
          status: 'ready',
          localPath,
          lastError: ''
        });
      }

      synced.push({ ...repo, status: 'ready', localPath, lastError: '' });
      continue;
    }

    if (repo.status === 'cloning') {
      synced.push({ ...repo, localPath });
      continue;
    }

    try {
      await reportRepoStatus(apiBase, repoId, {
        status: 'cloning',
        localPath,
        lastError: ''
      });

      logger.log(`[仓库同步] 开始拉取: ${repo.name || repo.repoUrl}`);
      cloneRepo(repo, localPath);

      await reportRepoStatus(apiBase, repoId, {
        status: 'ready',
        localPath,
        lastError: ''
      });

      logger.log(`[仓库同步] 拉取完成: ${repo.name || repo.repoUrl}`);
      synced.push({ ...repo, status: 'ready', localPath, lastError: '' });
    } catch (error) {
      const message = maskCredential(error.message || '仓库拉取失败');
      await reportRepoStatus(apiBase, repoId, {
        status: 'failed',
        localPath,
        lastError: message
      });

      logger.error(`[仓库同步] 失败: ${repo.name || repo.repoUrl} - ${message}`);
      synced.push({ ...repo, status: 'failed', localPath, lastError: message });
    }
  }

  return synced;
}

module.exports = {
  fetchGitRepos,
  syncGitRepos
};
