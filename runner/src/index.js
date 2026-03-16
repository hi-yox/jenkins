const path = require('path');
const { getRemoteBranches, reportBranches } = require('./branches');
const { fetchConfig, processConfig } = require('./builder');

// ============================================================
// 解析命令行参数
// ============================================================
const args = process.argv.slice(2);

function getArg(name, defaultValue) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return defaultValue;
  return args[index + 1];
}

const API_BASE = getArg('--api', 'http://130.94.33.164:8081');
const REPO_DIR = getArg('--repo', '');               // git 仓库目录（必填）
const BUILD_DIR = getArg('--build-dir', '');          // 打包工作目录，默认同 repo
const SCRIPT_PATH = getArg('--script', '');           // auto_build.sh 路径
const BRANCH_INTERVAL = parseInt(getArg('--branch-interval', '60'), 10);  // 秒
const CONFIG_INTERVAL = parseInt(getArg('--config-interval', '10'), 10);  // 秒

if (!REPO_DIR) {
  console.error('错误: 请通过 --repo 指定 git 仓库目录');
  console.error('');
  console.error('用法:');
  console.error('  node src/index.js --repo /path/to/repo [选项] --build-dir build_dir');
  console.error('');
  console.error('选项:');
  console.error('  --api <url>              后端地址 (默认: http://130.94.33.164:8081)');
  console.error('  --repo <path>            git 仓库目录 (必填)');
  console.error('  --build-dir <path>       打包工作目录 (默认: 同 --repo)');
  console.error('  --script <path>          auto_build.sh 路径 (默认: <build-dir>/auto_build.sh)');
  console.error('  --branch-interval <sec>  分支上报间隔秒数 (默认: 60)');
  console.error('  --config-interval <sec>  配置查询间隔秒数 (默认: 10)');
  process.exit(1);
}

const resolvedBuildDir = BUILD_DIR || REPO_DIR;
const resolvedScript = SCRIPT_PATH || path.join(resolvedBuildDir, 'auto_build.sh');

console.log('============================================================');
console.log('Build Runner 启动');
console.log(`  后端地址:       ${API_BASE}`);
console.log(`  仓库目录:       ${REPO_DIR}`);
console.log(`  打包目录:       ${resolvedBuildDir}`);
console.log(`  打包脚本:       ${resolvedScript}`);
console.log(`  分支上报间隔:   ${BRANCH_INTERVAL}s`);
console.log(`  配置查询间隔:   ${CONFIG_INTERVAL}s`);
console.log('============================================================');

// ============================================================
// 定时任务 1: 上报分支
// ============================================================
let branchReporting = false;

async function doBranchReport() {
  if (branchReporting) return;
  branchReporting = true;
  try {
    const branches = getRemoteBranches(REPO_DIR);
    if (branches.length > 0) {
      const result = await reportBranches(API_BASE, branches);
      console.log(`[分支上报] 已上报 ${result.count} 个分支`);
    } else {
      console.log('[分支上报] 未检测到远程分支');
    }
  } catch (err) {
    console.error(`[分支上报] 失败: ${err.message}`);
  } finally {
    branchReporting = false;
  }
}

// 立即执行一次，然后定时
doBranchReport();
setInterval(doBranchReport, BRANCH_INTERVAL * 1000);

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

    console.log(`[配置查询] 收到打包配置: appName=${config.appName}, branch=${config.branch || '(默认)'}`);
    building = true;

    try {
      await processConfig(config, REPO_DIR, resolvedBuildDir, resolvedScript);
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

// 立即执行一次，然后定时
doConfigPoll();
setInterval(doConfigPoll, CONFIG_INTERVAL * 1000);
