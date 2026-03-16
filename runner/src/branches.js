const { execSync } = require('child_process');

/**
 * 获取指定 git 仓库目录的远程分支列表
 * @param {string} repoDir git 仓库目录
 * @returns {string[]}
 */
function getRemoteBranches(repoDir) {
  // 先 fetch 最新远程信息
  execSync('git fetch --prune', { cwd: repoDir, stdio: 'ignore' });

  const output = execSync('git branch -r', { cwd: repoDir, encoding: 'utf-8' });
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.includes('->'))  // 排除 HEAD -> origin/main
    .map(line => line.replace(/^origin\//, ''));
}

/**
 * 上报分支列表到后端
 * @param {string} apiBase 后端地址
 * @param {string[]} branches 分支列表
 */
async function reportBranches(apiBase, branches) {
  const res = await fetch(`${apiBase}/api/branches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branches })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`上报分支失败: ${res.status} ${err.error || ''}`);
  }

  return res.json();
}

module.exports = { getRemoteBranches, reportBranches };
