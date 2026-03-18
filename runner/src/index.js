const path = require('path');
const { getRemoteBranches, reportBranches } = require('./branches');
const { fetchConfig, processConfig } = require('./builder');
const { fetchGitRepos, syncGitRepos } = require('./git-repos');

// ============================================================
// 解析命令行参数
// ============================================================
const args = process.argv.slice(2);

function getArg(name, defaultValue) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return defaultValue;
  return args[index + 1];
}

const API_BASE = getArg('--api', 'http://127.0.0.1:8081');
const REPO_DIR = getArg('--repo', '');                // 兼容旧模式：固定仓库目录
const BUILD_DIR = getArg('--build-dir', '');          // 打包工作目录，默认同 repo 或 cwd
const SCRIPT_PATH = getArg('--script', '');           // auto_build.sh 路径
const REPOS_ROOT = getArg('--repos-root', path.join(process.cwd(), 'repos')); // 多仓库克隆目录
const BRANCH_INTERVAL = parseInt(getArg('--branch-interval', '60'), 10);  // 秒
const REPO_SYNC_INTERVAL = parseInt(getArg('--repo-sync-interval', '20'), 10); // 秒
const CONFIG_INTERVAL = parseInt(getArg('--config-interval', '10'), 10);  // 秒
const RUN_MODE = String(getArg('--mode', 'build')).trim().toLowerCase(); // build | repo-sync | all

const isRepoMode = RUN_MODE === 'repo-sync' || RUN_MODE === 'all';
const isBuildMode = RUN_MODE === 'build' || RUN_MODE === 'all';

if (!isRepoMode && !isBuildMode) {
  console.error('错误: --mode 仅支持 build / repo-sync / all');
  process.exit(1);
}

const resolvedRepoDir = REPO_DIR ? path.resolve(REPO_DIR) : '';
const resolvedBuildDir = path.resolve(BUILD_DIR || REPO_DIR || process.cwd());
const resolvedScript = path.resolve(SCRIPT_PATH || path.join(resolvedBuildDir, 'auto_build.sh'));
const resolvedReposRoot = path.resolve(REPOS_ROOT);

if (!resolvedRepoDir) {
  console.log('[启动提示] 未指定 --repo，runner 将仅使用 /api/git-repos 中的仓库配置进行拉取与打包。');
}

console.log('============================================================');
console.log('Build Runner 启动');
console.log(`  运行模式:       ${RUN_MODE}`);
console.log(`  后端地址:       ${API_BASE}`);
console.log(`  固定仓库目录:   ${resolvedRepoDir || '(未设置)'}`);
console.log(`  仓库克隆目录:   ${resolvedReposRoot}`);
console.log(`  打包目录:       ${resolvedBuildDir}`);
console.log(`  打包脚本:       ${resolvedScript}`);
console.log(`  仓库同步间隔:   ${REPO_SYNC_INTERVAL}s`);
console.log(`  分支上报间隔:   ${BRANCH_INTERVAL}s`);
console.log(`  配置查询间隔:   ${CONFIG_INTERVAL}s`);
console.log('============================================================');

async function uploadBuildLog(roomId, message, level = 'info', done = false, status = '') {
  if (!roomId) {
    return;
  }

  try {
    await fetch(`${API_BASE}/api/build-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId,
        message,
        level,
        done,
        status,
        timestamp: new Date().toISOString()
      })
    });
  } catch (error) {
    console.error(`[日志上传] 失败: ${error.message}`);
  }
}

let cachedRepos = [];

function getReadyRepos() {
  return cachedRepos.filter((item) => item.status === 'ready' && item.localPath);
}

function findReadyRepoById(repoId) {
  const normalizedRepoId = String(repoId || '').trim();
  if (!normalizedRepoId) {
    return null;
  }

  return getReadyRepos().find((item) => String(item.id || '') === normalizedRepoId) || null;
}

async function refreshRepoCache() {
  try {
    cachedRepos = await syncGitRepos(API_BASE, resolvedReposRoot, console);
  } catch (error) {
    console.error(`[仓库同步] 失败: ${error.message}`);
  }
}

// ============================================================
// 定时任务 0: 仓库同步
// ============================================================
let repoSyncing = false;

async function doRepoSync() {
  if (repoSyncing) {
    return;
  }

  repoSyncing = true;
  try {
    await refreshRepoCache();
  } finally {
    repoSyncing = false;
  }
}

if (isRepoMode) {
  // 立即执行一次，然后定时
  doRepoSync();
  setInterval(doRepoSync, REPO_SYNC_INTERVAL * 1000);
} else {
  console.log('[模式] 已禁用仓库拉取与分支上报任务');
}

// ============================================================
// 定时任务 1: 上报分支
// ============================================================
let branchReporting = false;

async function doBranchReport() {
  if (branchReporting) return;
  branchReporting = true;
  try {
    const readyRepos = getReadyRepos();

    if (readyRepos.length > 0) {
      for (const repo of readyRepos) {
        try {
          const branches = getRemoteBranches(repo.localPath);
          if (branches.length === 0) {
            continue;
          }

          const result = await reportBranches(API_BASE, repo.id, repo.name, branches);
          console.log(`[分支上报] ${repo.name || repo.id}: ${result.count} 个分支`);
        } catch (error) {
          console.error(`[分支上报] ${repo.name || repo.id} 失败: ${error.message}`);
        }
      }
      return;
    }

    if (resolvedRepoDir) {
      const branches = getRemoteBranches(resolvedRepoDir);
      if (branches.length > 0) {
        const result = await reportBranches(API_BASE, 'default', 'default', branches);
        console.log(`[分支上报] default: ${result.count} 个分支`);
      } else {
        console.log('[分支上报] 未检测到可上报分支');
      }
    }
  } catch (err) {
    console.error(`[分支上报] 失败: ${err.message}`);
  } finally {
    branchReporting = false;
  }
}

if (isRepoMode) {
  // 立即执行一次，然后定时
  doBranchReport();
  setInterval(doBranchReport, BRANCH_INTERVAL * 1000);
}

// ============================================================
// 定时任务 2: 查询配置并打包
// ============================================================
let building = false;

async function doConfigPoll() {
  if (building) {
    return;
  }

  try {
    const config = await fetchConfig(API_BASE);
    if (!config) {
      // 无配置，静默跳过
      return;
    }

    const roomId = String(config.roomId || '').trim();
    const repoId = String(config.repoId || '').trim();

    let targetRepoDir = '';
    if (repoId) {
      let repo = findReadyRepoById(repoId);
      if (!repo) {
        try {
          cachedRepos = await fetchGitRepos(API_BASE);
          repo = findReadyRepoById(repoId);
        } catch (_) {
          // 读取仓库列表失败时，沿用缓存结果
        }
      }

      if (!repo) {
        const message = `[配置查询] 仓库未就绪或不存在，repoId=${repoId}`;
        console.error(message);
        await uploadBuildLog(roomId, message, 'error', true, 'failed');
        return;
      }

      targetRepoDir = repo.localPath;
    } else if (resolvedRepoDir) {
      targetRepoDir = resolvedRepoDir;
    } else {
      const message = '[配置查询] 未提供 repoId 且未配置固定 --repo，无法执行打包';
      console.error(message);
      await uploadBuildLog(roomId, message, 'error', true, 'failed');
      return;
    }

    console.log(`[配置查询] 收到打包配置: appName=${config.appName}, repo=${repoId || 'default'}, branch=${config.branch || '(默认)'}`);
    building = true;

    try {
      await processConfig(config, targetRepoDir, resolvedBuildDir, resolvedScript, API_BASE);
      console.log('[配置查询] 打包任务完成');
    } catch (err) {
      console.error(`[配置查询] 打包失败: ${err.message}`);
    } finally {
      building = false;
    }
  } catch (err) {
    console.error(`[配置查询] 查询失败: ${err.message}`);
  }
}

if (isBuildMode) {
  // 立即执行一次，然后定时
  doConfigPoll();
  setInterval(doConfigPoll, CONFIG_INTERVAL * 1000);
} else {
  console.log('[模式] 已禁用配置消费与打包任务');
}
