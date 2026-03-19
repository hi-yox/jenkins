const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { execSync, spawn } = require('child_process');

function trimTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function uploadBuildPackage(apiBase, ipaPath, options = {}) {
  const normalizedApiBase = trimTrailingSlash(apiBase);
  const uploadUrl = `${normalizedApiBase}/api/upload`;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const progressStepPercent = Number(options.progressStepPercent) > 0 ? Number(options.progressStepPercent) : 10;

  const output = await new Promise((resolve, reject) => {
    const args = ['-S', '-f', '-#', '-X', 'POST', '-F', `files=@${ipaPath}`, uploadUrl];
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let progressBuffer = '';
    let lastProgress = -1;

    function maybeEmitProgress(line) {
      if (!onProgress) {
        return false;
      }

      const matches = [...line.matchAll(/(\d{1,3}(?:\.\d+)?)%/g)];
      if (matches.length === 0) {
        return false;
      }

      const percent = Math.max(0, Math.min(100, Math.floor(Number(matches[matches.length - 1][1]))));
      if (!Number.isFinite(percent)) {
        return false;
      }

      if (percent === 100 || percent >= lastProgress + progressStepPercent) {
        lastProgress = percent;
        try {
          onProgress(percent);
        } catch (_error) {
          // 上传进度回调异常不应影响主流程
        }
      }
      return true;
    }

    function processStderrChunk(chunkText) {
      stderr += chunkText;
      progressBuffer += chunkText;

      const lines = progressBuffer.split(/\r?\n|\r/g);
      progressBuffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        maybeEmitProgress(line);
      }
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      processStderrChunk(chunk.toString());
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (progressBuffer.trim()) {
        maybeEmitProgress(progressBuffer.trim());
      }

      if (code !== 0) {
        reject(new Error(`上传 IPA 失败: ${stderr.trim() || `curl 退出码 ${code}`}`));
        return;
      }

      if (onProgress && lastProgress < 100) {
        try {
          onProgress(100);
        } catch (_error) {
          // 上传进度回调异常不应影响主流程
        }
      }

      resolve(stdout);
    });
  });

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (_error) {
    throw new Error('上传 IPA 失败: 服务端响应不是合法 JSON');
  }

  const file = parsed?.files?.[0];
  if (!file?.downloadUrl) {
    throw new Error('上传 IPA 失败: 未返回 downloadUrl');
  }

  return file;
}

async function uploadBuildPackageWithRetry(apiBase, ipaPath, options = {}) {
  const retryDelayMs = Number(options.retryDelayMs) > 0 ? Number(options.retryDelayMs) : 5000;
  const onRetryLog = typeof options.onRetryLog === 'function' ? options.onRetryLog : null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const progressStepPercent = Number(options.progressStepPercent) > 0 ? Number(options.progressStepPercent) : 10;

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await uploadBuildPackage(apiBase, ipaPath, {
        onProgress,
        progressStepPercent
      });
    } catch (error) {
      const message = `[构建] IPA 上传失败（第 ${attempt} 次）: ${error.message}，${Math.floor(retryDelayMs / 1000)} 秒后重试`;
      if (onRetryLog) {
        await onRetryLog(message);
      } else {
        console.error(message);
      }
      await sleep(retryDelayMs);
    }
  }
}

async function saveBuildArtifact(apiBase, payload) {
  const normalizedApiBase = trimTrailingSlash(apiBase);
  const requestUrl = `${normalizedApiBase}/api/build-artifacts`;

  let res;
  try {
    res = await fetch(requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    throw new Error(formatFetchError(error, 'POST', requestUrl));
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${requestUrl} 返回异常状态: ${res.status} ${text}`);
  }

  return res.json();
}

/**
 * 消费后端最老配置（查询后从队列删除）
 * @param {string} apiBase
 * @returns {Promise<object|null>}
 */
async function fetchConfig(apiBase) {
  const requestUrl = `${apiBase}/api/config/consume`;

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
    const requestUrl = `${apiBase}/api/build-logs`;
    await fetch(requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, message, level, done, status, timestamp: new Date().toISOString() })
    });
  } catch (error) {
    console.error(`[日志上传] 失败: ${formatFetchError(error, 'POST', `${apiBase}/api/build-logs`)}`);
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
 * @param {string} _buildDir 保留参数（兼容旧调用）
 * @param {string} scriptPath auto_build.sh 路径
 */
async function processConfig(config, repoDir, _buildDir, scriptPath, apiBase) {
  const roomId = String(config.roomId || '').trim();

  // 打包前清理已跟踪文件改动，避免脏工作区影响打包。
  console.log('[构建前清理] 执行 git checkout -- .');
  try {
    execSync('git checkout -- .', { cwd: repoDir, stdio: 'inherit' });
    await uploadBuildLog(apiBase, roomId, '[构建前清理] 已执行 git checkout -- .', 'info');
  } catch (error) {
    await uploadBuildLog(apiBase, roomId, `[构建前清理] 失败: ${error.message}`, 'error', true, 'failed');
    throw new Error(`构建前清理失败: ${error.message}`);
  }

  // 创建临时资源目录
  const assetsDir = path.join(repoDir, 'build-assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  const domainConfig = {
    appName: config.appName || '',
    opKey: config.opKey || '',
    requestHttp: config.requestHttp || '',
    version: config.version || '',
    domain: config.domain || [],
    'release-configuration': ''
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
    domainConfig.icon = path.relative(repoDir, iconDir);
    console.log(`[完成] 图标已解压到: ${iconDir}`);
  }

  // 下载启动图
  if (config.LaunchScreen) {
    const ext = getExtFromUrl(config.LaunchScreen) || '.jpg';
    const launchFile = path.join(assetsDir, `LaunchScreen${ext}`);
    console.log(`[下载] 启动图: ${config.LaunchScreen}`);
    await downloadFile(config.LaunchScreen, launchFile, '启动图');
    domainConfig.LaunchScreen = path.relative(repoDir, launchFile);
    console.log(`[完成] 启动图: ${launchFile}`);
  }

  // 下载证书
  if (config.cert) {
    const ext = getExtFromUrl(config.cert) || '.mobileprovision';
    const certFile = path.join(assetsDir, `cert${ext}`);
    console.log(`[下载] 证书: ${config.cert}`);
    await downloadFile(config.cert, certFile, '证书');
    domainConfig.cert = path.relative(repoDir, certFile);
    console.log(`[完成] 证书: ${certFile}`);
  }

  // 下载发布配置（release-configuration）
  if (config['release-configuration']) {
    const releaseConfigUrl = config['release-configuration'];
    const ext = getExtFromUrl(releaseConfigUrl) || '.json';
    const releaseConfigFile = path.join(assetsDir, `release-configuration${ext}`);
    console.log(`[下载] 发布配置: ${releaseConfigUrl}`);
    await downloadFile(releaseConfigUrl, releaseConfigFile, '发布配置');
    domainConfig['release-configuration'] = path.relative(repoDir, releaseConfigFile);
    console.log(`[完成] 发布配置: ${releaseConfigFile}`);
  }

  // 写入 domain.json
  const domainJsonPath = path.join(repoDir, 'domain.json');
  fs.writeFileSync(domainJsonPath, JSON.stringify(domainConfig, null, 2) + '\n');
  console.log(`[完成] domain.json 已生成: ${domainJsonPath}`);

  // 构建参数
  const args = ['--config', 'domain.json'];
  const buildLogPath = path.join(assetsDir, `build-${Date.now()}.log`);
  const buildOutputIpaPath = path.join(repoDir, 'build-output', 'Telegram.ipa');

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
  console.log(`[构建] 开始执行: (cd ${repoDir} && ./auto_build.sh ${args.join(' ')})`);
  await logAndUpload(`[构建] 开始执行: (cd ${repoDir} && ./auto_build.sh ${args.join(' ')})`);
  try {
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('./auto_build.sh', args, {
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

      if (!fs.existsSync(buildOutputIpaPath)) {
        throw new Error(`构建产物不存在: ${buildOutputIpaPath}`);
      }

      await logAndUpload(`[构建] 开始上传 IPA: ${buildOutputIpaPath}`);
      const uploadedFile = await uploadBuildPackageWithRetry(apiBase, buildOutputIpaPath, {
        retryDelayMs: 5000,
        progressStepPercent: 10,
        onProgress: (percent) => {
          const progressMessage = `[构建] IPA 上传进度: ${percent}%`;
          console.log(progressMessage);
          appendBuildLog(progressMessage);
          uploadBuildLog(apiBase, roomId, progressMessage, 'info');
        },
        onRetryLog: async (message) => {
          await logAndUpload(message, 'error');
        }
      });
      await logAndUpload(`[构建] IPA 上传完成: ${uploadedFile.downloadUrl}`);

      const artifactPayload = {
        roomId,
        appName: config.appName || '',
        version: config.version || '',
        branch: config.branch || '',
        opKey: config.opKey || '',
        requestHttp: config.requestHttp || '',
        domain: config.domain || [],
        buildArgs: args,
        packagePath: buildOutputIpaPath,
        downloadUrl: uploadedFile.downloadUrl,
        packageSize: uploadedFile.size || 0,
        originalName: uploadedFile.originalName || 'Telegram.ipa',
        savedName: uploadedFile.savedName || '',
        buildLogPath,
        createdAt: new Date().toISOString()
      };

      await saveBuildArtifact(apiBase, artifactPayload);
      await logAndUpload('[构建] 打包结果已保存到服务端');

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

    // 打包后再次清理已跟踪文件改动，减少后续任务污染。
    console.log('[构建后清理] 执行 git checkout -- .');
    try {
      execSync('git checkout -- .', { cwd: repoDir, stdio: 'inherit' });
      await logAndUpload('[构建后清理] 已执行 git checkout -- .');
    } catch (error) {
      console.error(`[构建后清理] 失败: ${error.message}`);
      await logAndUpload(`[构建后清理] 失败: ${error.message}`, 'error');
    }
  }
}

module.exports = { fetchConfig, processConfig };
