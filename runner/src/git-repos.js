const fs = require('fs');
const os = require('os');
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

function formatFetchError(error, method, url) {
  const message = String(error?.message || 'fetch failed');
  const cause = error?.cause;

  if (!cause) {
    return `${method} ${url} 失败: ${message}`;
  }

  const causeParts = [
    cause.code,
    cause.errno,
    cause.syscall,
    cause.address,
    cause.port !== undefined ? String(cause.port) : ''
  ].filter(Boolean);

  const causeText = causeParts.length > 0 ? ` (${causeParts.join(' ')})` : '';
  return `${method} ${url} 失败: ${message}${causeText}`;
}

function normalizeCloneRepoUrl(repoUrl) {
  const normalized = String(repoUrl || '').trim();
  if (!normalized) {
    throw new Error('仓库地址为空');
  }

  if (/^git@/i.test(normalized) || /^ssh:\/\//i.test(normalized)) {
    return { url: normalized, protocol: 'ssh' };
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { url: normalized, protocol: parsed.protocol.replace(':', '') || 'unknown' };
    }

    // 避免 URL 中残留用户名密码
    parsed.username = '';
    parsed.password = '';
    return { url: parsed.toString(), protocol: parsed.protocol.replace(':', '') };
  } catch (_) {
    return { url: normalized, protocol: 'unknown' };
  }
}

function extractExecError(error) {
  const stderrText = error?.stderr ? String(error.stderr) : '';
  const stdoutText = error?.stdout ? String(error.stdout) : '';
  const merged = [stderrText.trim(), stdoutText.trim(), String(error?.message || '').trim()]
    .filter(Boolean)
    .join(' | ');

  return maskCredential(merged || '仓库拉取失败');
}

function isGitRepo(localPath) {
  if (!localPath) {
    return false;
  }

  const gitDir = path.join(localPath, '.git');
  return fs.existsSync(gitDir);
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
  const requestUrl = `${normalizedApiBase}/api/git-repos`;

  let res;
  try {
    res = await fetch(requestUrl);
  } catch (error) {
    throw new Error(formatFetchError(error, 'GET', requestUrl));
  }

  if (!res.ok) {
    throw new Error(`GET ${requestUrl} 返回异常状态: ${res.status}`);
  }

  const result = await res.json();
  return Array.isArray(result.items) ? result.items : [];
}

async function reportRepoStatus(apiBase, repoId, payload) {
  const normalizedApiBase = trimTrailingSlash(apiBase);
  const requestUrl = `${normalizedApiBase}/api/git-repos/${encodeURIComponent(repoId)}/status`;
  const requestBody = JSON.stringify(payload);

  let res;
  try {
    res = await fetch(requestUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody
    });
  } catch (error) {
    throw new Error(formatFetchError(error, 'PATCH', requestUrl));
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH ${requestUrl} 返回异常状态: ${res.status} ${text}`);
  }

  return res.json();
}

function cloneRepo(repo, localPath) {
  const username = String(repo.username || '').trim();
  const password = String(repo.password || '');
  const { url: cloneRepoUrl, protocol } = normalizeCloneRepoUrl(repo.repoUrl);

  if (!username) {
    throw new Error('仓库账号为空');
  }

  if (!password) {
    throw new Error('仓库密码为空');
  }

  if (protocol === 'ssh') {
    throw new Error('当前仓库地址是 SSH 协议，账号密码模式仅支持 HTTPS，请改为 https://...git 地址或改用 SSH Key');
  }

  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error(`不支持的仓库地址协议: ${protocol}`);
  }

  const askPassScriptPath = path.join(os.tmpdir(), `git-askpass-${process.pid}-${Date.now()}.sh`);
  const askPassScriptContent = [
    '#!/bin/sh',
    'case "$1" in',
    '  *Username*|*username*)',
    '    printf "%s\\n" "$GIT_AUTH_USERNAME"',
    '    ;;',
    '  *)',
    '    printf "%s\\n" "$GIT_AUTH_PASSWORD"',
    '    ;;',
    'esac',
    ''
  ].join('\n');

  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(askPassScriptPath, askPassScriptContent, { mode: 0o700 });

  try {
    execFileSync(
      'git',
      ['-c', `credential.username=${username}`, 'clone', '--recursive', '-j8', '--origin', 'origin', cloneRepoUrl, localPath],
      {
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: askPassScriptPath,
          GIT_AUTH_USERNAME: username,
          GIT_AUTH_PASSWORD: password
        }
      }
    );
  } catch (error) {
    throw new Error(extractExecError(error));
  } finally {
    try {
      fs.unlinkSync(askPassScriptPath);
    } catch (_) {
      // 忽略临时脚本清理失败
    }
  }
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
      logger.log(`[仓库同步] 上报状态: ${repo.name || repo.repoUrl} -> cloning`);
      await reportRepoStatus(apiBase, repoId, {
        status: 'cloning',
        localPath,
        lastError: ''
      });

      logger.log(`[仓库同步] 开始拉取: ${repo.name || repo.repoUrl}`);
      cloneRepo(repo, localPath);
      logger.log(`[仓库同步] 拉取完成，准备上报 ready: ${repo.name || repo.repoUrl}`);

      await reportRepoStatus(apiBase, repoId, {
        status: 'ready',
        localPath,
        lastError: ''
      });

      logger.log(`[仓库同步] 拉取完成: ${repo.name || repo.repoUrl}`);
      synced.push({ ...repo, status: 'ready', localPath, lastError: '' });
    } catch (error) {
      const message = maskCredential(error.message || '仓库拉取失败');

      try {
        logger.log(`[仓库同步] 上报状态: ${repo.name || repo.repoUrl} -> failed`);
        await reportRepoStatus(apiBase, repoId, {
          status: 'failed',
          localPath,
          lastError: message
        });
      } catch (reportError) {
        logger.error(`[仓库同步] failed 状态上报失败: ${repo.name || repo.repoUrl} - ${maskCredential(reportError.message || '状态上报失败')}`);
      }

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
