const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { execSync, spawn } = require('child_process');

/**
 * 消费后端最老配置（查询后从队列删除）
 * @param {string} apiBase
 * @returns {Promise<object|null>}
 */
async function fetchConfig(apiBase) {
  const res = await fetch(`${apiBase}/api/config/consume`);
  if (!res.ok) {
    throw new Error(`查询配置失败: ${res.status}`);
  }
  const result = await res.json();
  return result.data || null;
}

/**
 * 下载文件到指定路径
 * @param {string} url
 * @param {string} destPath
 * @param {string} label
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

async function downloadFile(url, destPath, label = '文件') {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载失败 (${res.status}): ${url}`);
  }

  if (!res.body) {
    throw new Error(`下载失败: 响应体为空: ${url}`);
  }

  const totalBytes = Number(res.headers.get('content-length')) || 0;
  const writer = fs.createWriteStream(destPath);
  const reader = res.body.getReader();

  let downloadedBytes = 0;
  let lastPercent = -1;
  let lastLoggedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      downloadedBytes += value.length;
      if (!writer.write(Buffer.from(value))) {
        await once(writer, 'drain');
      }

      if (totalBytes > 0) {
        const percent = Math.floor((downloadedBytes / totalBytes) * 100);
        if (percent >= lastPercent + 10 || percent === 100) {
          lastPercent = percent;
          console.log(`[下载进度] ${label}: ${percent}% (${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)})`);
        }
      } else if (downloadedBytes - lastLoggedBytes >= 1024 * 1024) {
        lastLoggedBytes = downloadedBytes;
        console.log(`[下载进度] ${label}: 已下载 ${formatBytes(downloadedBytes)}`);
      }
    }

    writer.end();
    await once(writer, 'finish');

    if (totalBytes > 0 && lastPercent < 100) {
      console.log(`[下载进度] ${label}: 100% (${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)})`);
    } else if (totalBytes === 0) {
      console.log(`[下载进度] ${label}: 下载完成，共 ${formatBytes(downloadedBytes)}`);
    }
  } catch (error) {
    writer.destroy();
    throw error;
  }
}

/**
 * 从 URL 中提取文件扩展名
 * @param {string} url
 * @returns {string}
 */
function getExtFromUrl(url) {
  const pathname = new URL(url).pathname;
  return path.extname(pathname) || '';
}

async function uploadBuildLog(apiBase, roomId, message, level = 'info', done = false, status = '') {
  if (!apiBase || !roomId) {
    return;
  }

  try {
    await fetch(`${apiBase}/api/build-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, message, level, done, status, timestamp: new Date().toISOString() })
    });
  } catch (error) {
    console.error(`[日志上传] 失败: ${error.message}`);
  }
}

function createStreamLineLogger(stream, onLine) {
  let buffer = '';

  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      onLine(line);
    }
  });

  stream.on('end', () => {
    if (buffer) {
      onLine(buffer);
      buffer = '';
    }
  });
}

/**
 * 处理配置：下载文件 + 生成 domain.json + 执行打包
 * @param {object} config 从后端获取的配置
 * @param {string} repoDir git 仓库目录
 * @param {string} buildDir 打包工作目录（即 auto_build.sh 所在目录）
 * @param {string} scriptPath auto_build.sh 路径
 */
async function processConfig(config, repoDir, buildDir, scriptPath, apiBase) {
  // 创建临时资源目录
  const assetsDir = path.join(buildDir, 'build-assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  const domainConfig = {
    appName: config.appName || '',
    opKey: config.opKey || '',
    requestHttp: config.requestHttp || '',
    version: config.version || '',
    domain: config.domain || []
  };

  // 下载图标 zip 并解压到 build-assets/icon/
  if (config.icon) {
    const iconZip = path.join(assetsDir, `icon${getExtFromUrl(config.icon)}`);
    console.log(`[下载] 图标: ${config.icon}`);
    await downloadFile(config.icon, iconZip, '图标');

    const iconDir = path.join(assetsDir, 'icon');
    if (fs.existsSync(iconDir)) {
      fs.rmSync(iconDir, { recursive: true });
    }
    fs.mkdirSync(iconDir, { recursive: true });
    execSync(`unzip -o "${iconZip}" -d "${iconDir}"`, { stdio: 'ignore' });
    domainConfig.icon = path.relative(buildDir, iconDir);
    console.log(`[完成] 图标已解压到: ${iconDir}`);
  }

  // 下载启动图
  if (config.LaunchScreen) {
    const ext = getExtFromUrl(config.LaunchScreen) || '.jpg';
    const launchFile = path.join(assetsDir, `LaunchScreen${ext}`);
    console.log(`[下载] 启动图: ${config.LaunchScreen}`);
    await downloadFile(config.LaunchScreen, launchFile, '启动图');
    domainConfig.LaunchScreen = path.relative(buildDir, launchFile);
    console.log(`[完成] 启动图: ${launchFile}`);
  }

  // 下载证书
  if (config.cert) {
    const ext = getExtFromUrl(config.cert) || '.mobileprovision';
    const certFile = path.join(assetsDir, `cert${ext}`);
    console.log(`[下载] 证书: ${config.cert}`);
    await downloadFile(config.cert, certFile, '证书');
    domainConfig.cert = path.relative(buildDir, certFile);
    console.log(`[完成] 证书: ${certFile}`);
  }

  // 写入 domain.json
  const domainJsonPath = path.join(buildDir, 'domain.json');
  fs.writeFileSync(domainJsonPath, JSON.stringify(domainConfig, null, 2) + '\n');
  console.log(`[完成] domain.json 已生成: ${domainJsonPath}`);

  // 构建参数
  const args = ['--config', domainJsonPath, '--repo-dir', repoDir];
  const roomId = String(config.roomId || '').trim();
  const buildLogPath = path.join(assetsDir, `build-${Date.now()}.log`);

  function appendBuildLog(message) {
    fs.appendFileSync(buildLogPath, `${message}\n`);
  }

  async function logAndUpload(message, level = 'info') {
    appendBuildLog(message);
    await uploadBuildLog(apiBase, roomId, message, level);
  }

  if (config.branch) {
    // 切换到目标分支
    console.log(`[分支] 切换到分支: ${config.branch}`);
    try {
      execSync('git fetch --all --prune', { cwd: repoDir, stdio: 'inherit' });
      execSync(`git checkout -B ${config.branch} origin/${config.branch}`, { cwd: repoDir, stdio: 'inherit' });
      execSync(`git pull origin ${config.branch}`, { cwd: repoDir, stdio: 'inherit' });
    } catch (err) {
      console.error(`[错误] 切换分支失败: ${err.message}`);
      throw err;
    }
  }

  // 执行 auto_build.sh
  const tempScriptPath = path.join(repoDir, path.basename(scriptPath));
  fs.copyFileSync(scriptPath, tempScriptPath);
  fs.chmodSync(tempScriptPath, 0o755);

  await logAndUpload(`[构建] 日志文件: ${buildLogPath}`);
  console.log(`[构建] 开始执行: ${tempScriptPath} ${args.join(' ')}`);
  await logAndUpload(`[构建] 开始执行: ${tempScriptPath} ${args.join(' ')}`);
  try {
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('bash', [tempScriptPath, ...args], {
          cwd: repoDir,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        createStreamLineLogger(child.stdout, (line) => {
          console.log(line);
          appendBuildLog(line);
          uploadBuildLog(apiBase, roomId, line, 'info');
        });

        createStreamLineLogger(child.stderr, (line) => {
          console.error(line);
          appendBuildLog(line);
          uploadBuildLog(apiBase, roomId, line, 'error');
        });

        child.on('close', (code) => {
          if (code === 0) {
            console.log('[构建] 打包完成');
            resolve();
          } else {
            reject(new Error(`打包失败，退出码: ${code}`));
          }
        });

        child.on('error', reject);
      });

      await uploadBuildLog(apiBase, roomId, '[构建] 打包完成', 'info', true, 'success');
    } catch (error) {
      await uploadBuildLog(apiBase, roomId, `[构建] 打包失败: ${error.message}`, 'error', true, 'failed');
      throw error;
    }
  } finally {
    if (fs.existsSync(tempScriptPath)) {
      fs.unlinkSync(tempScriptPath);
      console.log(`[清理] 已删除临时脚本: ${tempScriptPath}`);
      await logAndUpload(`[清理] 已删除临时脚本: ${tempScriptPath}`);
    }
  }
}

module.exports = { fetchConfig, processConfig };
