const fs = require('fs');
const path = require('path');
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
 */
async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载失败 (${res.status}): ${url}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
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

/**
 * 处理配置：下载文件 + 生成 domain.json + 执行打包
 * @param {object} config 从后端获取的配置
 * @param {string} buildDir 打包工作目录（即 auto_build.sh 所在目录）
 * @param {string} scriptPath auto_build.sh 路径
 */
async function processConfig(config, buildDir, scriptPath) {
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
    await downloadFile(config.icon, iconZip);

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
    await downloadFile(config.LaunchScreen, launchFile);
    domainConfig.LaunchScreen = path.relative(buildDir, launchFile);
    console.log(`[完成] 启动图: ${launchFile}`);
  }

  // 下载证书
  if (config.cert) {
    const ext = getExtFromUrl(config.cert) || '.mobileprovision';
    const certFile = path.join(assetsDir, `cert${ext}`);
    console.log(`[下载] 证书: ${config.cert}`);
    await downloadFile(config.cert, certFile);
    domainConfig.cert = path.relative(buildDir, certFile);
    console.log(`[完成] 证书: ${certFile}`);
  }

  // 写入 domain.json
  const domainJsonPath = path.join(buildDir, 'domain.json');
  fs.writeFileSync(domainJsonPath, JSON.stringify(domainConfig, null, 2) + '\n');
  console.log(`[完成] domain.json 已生成: ${domainJsonPath}`);

  // 构建参数
  const args = ['--config', domainJsonPath];
  if (config.branch) {
    // 切换到目标分支
    console.log(`[分支] 切换到分支: ${config.branch}`);
    try {
      execSync(`git fetch --all`, { cwd: buildDir, stdio: 'inherit' });
      execSync(`git checkout ${config.branch}`, { cwd: buildDir, stdio: 'inherit' });
      execSync(`git pull origin ${config.branch}`, { cwd: buildDir, stdio: 'inherit' });
    } catch (err) {
      console.error(`[错误] 切换分支失败: ${err.message}`);
      throw err;
    }
  }

  // 执行 auto_build.sh
  console.log(`[构建] 开始执行: ${scriptPath} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath, ...args], {
      cwd: buildDir,
      stdio: 'inherit'
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
}

module.exports = { fetchConfig, processConfig };
