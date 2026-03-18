<script>
  import { onDestroy } from 'svelte';
  import { io } from 'socket.io-client';
  import { uploadFile, saveConfig, getConfig, getBranches, getBuildLogs, getBuildArtifacts, SOCKET_BASE } from './api.js';

  const uploadFields = [
    { key: 'icon', inputId: 'iconFile', label: '图标 ZIP 文件', accept: '.zip' },
    { key: 'LaunchScreen', inputId: 'launchScreenFile', label: '启动图文件', accept: '.jpg,.jpeg,.png' },
    { key: 'cert', inputId: 'certFile', label: '证书文件', accept: '.mobileprovision,.p12,.cer,.pem' },
    { key: 'releaseConfiguration', inputId: 'releaseConfigurationFile', label: '发布配置文件 (release-configuration)', accept: '.json' }
  ];

  function createUploadState() {
    return {
      fileName: '',
      progress: 0,
      status: 'idle',
      url: '',
      error: '',
      requestId: 0
    };
  }

  let appName = $state('');
  let opKey = $state('');
  let requestHttp = $state('');
  let version = $state('');
  let branch = $state('');
  let branches = $state([]);
  let domains = $state([{ ip: '', port: 443 }]);
  let uploadStates = $state({
    icon: createUploadState(),
    LaunchScreen: createUploadState(),
    cert: createUploadState(),
    releaseConfiguration: createUploadState()
  });
  let uploadInputKeys = $state({
    icon: 0,
    LaunchScreen: 0,
    cert: 0,
    releaseConfiguration: 0
  });

  let submitting = $state(false);
  let message = $state('');
  let messageType = $state('');
  let queriedConfig = $state(null);
  let querying = $state(false);
  let activeRoomId = $state('');
  let buildLogs = $state([]);
  let buildArtifacts = $state([]);
  let loadingArtifacts = $state(false);
  let testRoomId = $state('');
  let joiningRoom = $state(false);

  let socket = null;
  const LOG_RETRY_MAX_ATTEMPTS = 8;

  function pushBuildLog(entry) {
    buildLogs = [...buildLogs, entry].slice(-1000);
  }

  function resetBuildLogs(roomId) {
    activeRoomId = roomId;
    buildLogs = [];
  }

  async function loadBuildLogHistory(roomId) {
    if (!roomId) {
      return;
    }

    try {
      const result = await getBuildLogs(roomId);
      buildLogs = result.logs || [];
    } catch (_) {
      // 忽略历史日志加载失败，实时日志仍可继续接收
    }
  }

  async function loadBuildArtifacts() {
    loadingArtifacts = true;
    try {
      const result = await getBuildArtifacts();
      buildArtifacts = result.items || [];
    } catch (_) {
      // 不阻断页面使用
    } finally {
      loadingArtifacts = false;
    }
  }

  function connectLogRoom(roomId) {
    if (!roomId) {
      return;
    }

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    socket = io(SOCKET_BASE, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: LOG_RETRY_MAX_ATTEMPTS,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
      timeout: 10000
    });

    socket.on('connect', () => {
      socket.emit('join-room', roomId);
      pushBuildLog({
        roomId,
        message: '[系统] 已连接日志通道',
        level: 'info',
        timestamp: new Date().toISOString(),
        done: false,
        status: ''
      });
    });

    socket.io.on('reconnect_attempt', (attempt) => {
      pushBuildLog({
        roomId,
        message: `[系统] 日志通道重连中 (${attempt}/${LOG_RETRY_MAX_ATTEMPTS})`,
        level: 'warning',
        timestamp: new Date().toISOString(),
        done: false,
        status: ''
      });
    });

    socket.io.on('reconnect_failed', () => {
      pushBuildLog({
        roomId,
        message: '[系统] 日志通道重连失败，已达到最大重试次数，请稍后重新提交或刷新页面',
        level: 'error',
        timestamp: new Date().toISOString(),
        done: true,
        status: 'failed'
      });
    });

    socket.on('disconnect', (reason) => {
      if (reason === 'io client disconnect') {
        return;
      }

      pushBuildLog({
        roomId,
        message: `[系统] 日志连接已断开: ${reason}`,
        level: 'warning',
        timestamp: new Date().toISOString(),
        done: false,
        status: ''
      });
    });

    socket.on('build-log', (payload) => {
      if (payload?.roomId !== roomId) {
        return;
      }

      pushBuildLog(payload);
    });

    socket.on('connect_error', (error) => {
      const retrying = socket?.active;
      pushBuildLog({
        roomId,
        message: retrying
          ? `[系统] 日志连接失败: ${error.message}，将自动重试`
          : `[系统] 日志连接失败: ${error.message}`,
        level: 'error',
        timestamp: new Date().toISOString(),
        done: false,
        status: ''
      });
    });
  }

  onDestroy(() => {
    if (socket) {
      socket.disconnect();
    }
  });

  async function loadBranches() {
    try {
      const result = await getBranches();
      branches = result.branches || [];
      if (branches.length > 0 && !branch) {
        branch = branches[0];
      }
    } catch (_) {
      // 忽略错误，分支列表可能尚未上报
    }
  }

  $effect(() => {
    loadBranches();
    loadBuildArtifacts();
  });

  function addDomain() {
    domains = [...domains, { ip: '', port: 443 }];
  }

  function removeDomain(index) {
    domains = domains.filter((_, i) => i !== index);
  }

  function updateDomainIp(index, value) {
    domains = domains.map((d, i) => i === index ? { ...d, ip: value } : d);
  }

  function updateDomainPort(index, value) {
    domains = domains.map((d, i) => i === index ? { ...d, port: Number(value) } : d);
  }

  function showMessage(text, type = 'info') {
    message = text;
    messageType = type;
    setTimeout(() => {
      if (message === text) {
        message = '';
      }
    }, 5000);
  }

  function clearUpload(fieldKey) {
    uploadStates[fieldKey] = createUploadState();
    uploadInputKeys[fieldKey] += 1;
  }

  async function handleFileChange(fieldKey, fieldLabel, event) {
    const file = event.target.files?.[0] || null;

    if (!file) {
      clearUpload(fieldKey);
      return;
    }

    const requestId = uploadStates[fieldKey].requestId + 1;
    uploadStates[fieldKey] = {
      fileName: file.name,
      progress: 0,
      status: 'uploading',
      url: '',
      error: '',
      requestId
    };

    try {
      const result = await uploadFile(file, {
        onProgress: (percent) => {
          if (uploadStates[fieldKey].requestId !== requestId) {
            return;
          }

          uploadStates[fieldKey].progress = percent;
        }
      });

      if (uploadStates[fieldKey].requestId !== requestId) {
        return;
      }

      uploadStates[fieldKey].progress = 100;
      uploadStates[fieldKey].status = 'success';
      uploadStates[fieldKey].url = result.downloadUrl;
    } catch (err) {
      if (uploadStates[fieldKey].requestId !== requestId) {
        return;
      }

      uploadStates[fieldKey].status = 'error';
      uploadStates[fieldKey].progress = 0;
      uploadStates[fieldKey].error = err.message;
      showMessage(`${fieldLabel}上传失败: ${err.message}`, 'error');
    }
  }

  function hasUploadingFiles() {
    return uploadFields.some(({ key }) => uploadStates[key].status === 'uploading');
  }

  function hasFailedUploads() {
    return uploadFields.some(({ key }) => uploadStates[key].status === 'error');
  }

  function isSubmitDisabled() {
    return submitting || hasUploadingFiles() || hasFailedUploads();
  }

  function getSubmitLabel() {
    if (submitting) {
      return '提交中...';
    }

    if (hasUploadingFiles()) {
      return '文件上传中...';
    }

    if (hasFailedUploads()) {
      return '请先处理失败文件';
    }

    return '提交配置';
  }

  async function handleSubmit() {
    if (!appName.trim()) {
      showMessage('请填写应用名称', 'error');
      return;
    }

    if (hasUploadingFiles() || hasFailedUploads()) {
      showMessage('请等待所有文件上传完成后再提交', 'error');
      return;
    }

    submitting = true;
    message = '';
    const roomId = Date.now().toString();

    resetBuildLogs(roomId);
    connectLogRoom(roomId);
    await loadBuildLogHistory(roomId);

    try {
      const config = {
        appName: appName.trim(),
        opKey: opKey.trim(),
        requestHttp: requestHttp.trim(),
        version: version.trim(),
        branch: branch.trim(),
        roomId,
        domain: domains.filter(d => d.ip.trim()),
        icon: uploadStates.icon.url || '',
        LaunchScreen: uploadStates.LaunchScreen.url || '',
        cert: uploadStates.cert.url || '',
        'release-configuration': uploadStates.releaseConfiguration.url || ''
      };

      await saveConfig(config);
      showMessage('配置提交成功！', 'success');
      pushBuildLog({
        roomId,
        message: '[系统] 配置已提交，等待 runner 开始打包',
        level: 'info',
        timestamp: new Date().toISOString(),
        done: false,
        status: ''
      });
    } catch (err) {
      showMessage(`提交失败: ${err.message}`, 'error');
    } finally {
      submitting = false;
    }
  }

  async function handleJoinTestRoom() {
    const roomId = testRoomId.trim();
    if (!roomId) {
      showMessage('请输入 roomId 后再测试', 'error');
      return;
    }

    joiningRoom = true;
    message = '';
    resetBuildLogs(roomId);
    connectLogRoom(roomId);

    try {
      await loadBuildLogHistory(roomId);
      showMessage(`已加入测试房间: ${roomId}`, 'success');
      pushBuildLog({
        roomId,
        message: `[系统] 已手动加入测试房间 ${roomId}`,
        level: 'info',
        timestamp: new Date().toISOString(),
        done: false,
        status: ''
      });
    } catch (_) {
      // 历史日志拉取失败不影响实时连接
    } finally {
      joiningRoom = false;
    }
  }

  async function handleQuery() {
    querying = true;
    queriedConfig = null;
    try {
      const result = await getConfig();
      if (result.data) {
        queriedConfig = result.data;
        showMessage('查询成功，已返回最老配置，队列未删除', 'success');
      } else {
        showMessage('暂无配置数据', 'info');
      }
    } catch (err) {
      showMessage(`查询失败: ${err.message}`, 'error');
    } finally {
      querying = false;
    }
  }

  function getUploadSuccessCount() {
    return uploadFields.filter(({ key }) => uploadStates[key].status === 'success').length;
  }

  function getLatestLogEntry() {
    return buildLogs.length > 0 ? buildLogs[buildLogs.length - 1] : null;
  }

  function getBuildSummaryText() {
    const latest = getLatestLogEntry();

    if (!activeRoomId) {
      return '还没有发起新的打包任务。';
    }

    if (!latest) {
      return '任务房间已建立，正在等待 runner 输出日志。';
    }

    if (latest.status === 'failed' || latest.level === 'error') {
      return '最近状态包含错误，请优先检查右侧日志面板。';
    }

    if (latest.done || latest.status === 'success') {
      return '任务已结束，可以在下方已完成打包列表查看产物。';
    }

    return '任务执行中，日志会持续追加到右侧面板。';
  }
</script>

<main class="page-shell">
  <section class="hero-panel">
    <div class="hero-copy">
      <p class="eyebrow">Build Console</p>
      <h1>打包配置工作台</h1>
      <p class="hero-text">
        把配置、上传、实时日志和产物列表拆成并行工作区。填写参数时可以同时看到任务状态，而不是沿着单列页面来回滚动。
      </p>
    </div>

    <div class="hero-metrics">
      <div class="metric-card accent">
        <span class="metric-label">当前房间</span>
        <strong class="metric-value room-id">{activeRoomId || '未开始'}</strong>
      </div>
      <div class="metric-card">
        <span class="metric-label">上传进度</span>
        <strong class="metric-value">{getUploadSuccessCount()}/{uploadFields.length}</strong>
      </div>
      <div class="metric-card">
        <span class="metric-label">日志条数</span>
        <strong class="metric-value">{buildLogs.length}</strong>
      </div>
      <div class="metric-card">
        <span class="metric-label">已完成构建</span>
        <strong class="metric-value">{buildArtifacts.length}</strong>
      </div>
    </div>
  </section>

  {#if message}
    <div class="message-banner {messageType}">{message}</div>
  {/if}

  <div class="workspace-grid">
    <div class="editor-column">
      <form class="config-form" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        <section class="panel panel-basic">
          <div class="panel-heading">
            <div>
              <p class="panel-kicker">Core</p>
              <h2>基本信息</h2>
            </div>
            <button type="button" class="btn-secondary compact" onclick={loadBranches}>刷新分支</button>
          </div>

          <div class="field-grid">
            <div class="field field-span-2">
              <label for="appName">应用名称 <span class="required">*</span></label>
              <input id="appName" type="text" bind:value={appName} placeholder="例如: MyApp" required />
            </div>

            <div class="field">
              <label for="version">版本号</label>
              <input id="version" type="text" bind:value={version} placeholder="例如: 1.0.0" />
            </div>

            <div class="field field-span-2">
              <label for="opKey">OpenInstall APP_KEY</label>
              <input id="opKey" type="text" bind:value={opKey} placeholder="openinstall 的 APP_KEY" />
            </div>

            <div class="field field-span-2">
              <label for="requestHttp">请求地址 (requestHttp)</label>
              <input id="requestHttp" type="text" bind:value={requestHttp} placeholder="例如: https://api.example.com/config" />
            </div>

            <div class="field field-span-2">
              <label for="branch">分支</label>
              {#if branches.length > 0}
                <select id="branch" bind:value={branch}>
                  {#each branches as b}
                    <option value={b}>{b}</option>
                  {/each}
                </select>
              {:else}
                <input id="branch" type="text" bind:value={branch} placeholder="输入分支名，或等待客户端上报分支列表" />
              {/if}
            </div>
          </div>
        </section>

        <section class="panel panel-domain">
          <div class="panel-heading">
            <div>
              <p class="panel-kicker">Network</p>
              <h2>域名列表</h2>
            </div>
            <button type="button" class="btn-secondary compact" onclick={addDomain}>+ 添加域名</button>
          </div>

          <div class="domain-list">
            {#each domains as domain, i}
              <div class="domain-row">
                <input
                  type="text"
                  value={domain.ip}
                  oninput={(e) => updateDomainIp(i, e.target.value)}
                  placeholder="IP 地址或域名"
                  class="domain-ip"
                />
                <span class="separator">:</span>
                <input
                  type="number"
                  value={domain.port}
                  oninput={(e) => updateDomainPort(i, e.target.value)}
                  placeholder="端口"
                  class="domain-port"
                  min="1"
                  max="65535"
                />
                <button type="button" class="btn-remove" onclick={() => removeDomain(i)} title="删除">✕</button>
              </div>
            {/each}
          </div>
        </section>

        <section class="panel panel-upload">
          <div class="panel-heading">
            <div>
              <p class="panel-kicker">Assets</p>
              <h2>文件上传</h2>
            </div>
            <span class="panel-note">上传成功后会自动写入提交配置</span>
          </div>

          <div class="upload-grid">
            {#each uploadFields as field}
              {@const state = uploadStates[field.key]}
              <div class="upload-card">
                <div class="upload-card-header">
                  <label for={field.inputId}>{field.label}</label>
                  {#if state.fileName}
                    <button type="button" class="btn-text" onclick={() => clearUpload(field.key)}>清除</button>
                  {/if}
                </div>

                {#key uploadInputKeys[field.key]}
                  <input
                    id={field.inputId}
                    type="file"
                    accept={field.accept}
                    onchange={(e) => handleFileChange(field.key, field.label, e)}
                    disabled={state.status === 'uploading'}
                  />
                {/key}

                {#if state.fileName}
                  <div class="upload-meta">当前文件: {state.fileName}</div>
                {/if}

                {#if state.status === 'uploading'}
                  <div class="progress-row">
                    <div class="progress-track">
                      <div class="progress-fill" style={`width: ${state.progress}%`}></div>
                    </div>
                    <span class="progress-text">{state.progress}%</span>
                  </div>
                  <div class="upload-status uploading">上传中，请稍候...</div>
                {:else if state.status === 'success'}
                  <div class="upload-status success">上传完成</div>
                  <span class="file-link">上传地址: <a href={state.url} target="_blank" rel="noreferrer">{state.url}</a></span>
                {:else if state.status === 'error'}
                  <div class="upload-status error">上传失败: {state.error}</div>
                {:else}
                  <div class="upload-status idle">等待选择文件</div>
                {/if}
              </div>
            {/each}
          </div>
        </section>

        <section class="panel panel-actions">
          <div class="submit-copy">
            <p class="panel-kicker">Submit</p>
            <h2>提交与查询</h2>
            <p>{getBuildSummaryText()}</p>
          </div>

          <div class="actions">
            <button type="submit" class="btn-primary" disabled={isSubmitDisabled()}>
              {getSubmitLabel()}
            </button>
            <button type="button" class="btn-query" onclick={handleQuery} disabled={querying}>
              {querying ? '查询中...' : '查询配置'}
            </button>
          </div>
        </section>
      </form>

      {#if queriedConfig}
        <section class="panel result-panel">
          <div class="panel-heading">
            <div>
              <p class="panel-kicker">Queue</p>
              <h2>查询结果</h2>
            </div>
          </div>
          <pre>{JSON.stringify(queriedConfig, null, 2)}</pre>
        </section>
      {/if}
    </div>

    <aside class="insight-column">
      <section class="panel summary-panel">
        <div class="panel-heading">
          <div>
            <p class="panel-kicker">Overview</p>
            <h2>任务概览</h2>
          </div>
          <span class="status-pill {getLatestLogEntry()?.level || 'info'}">{activeRoomId ? '运行中视图' : '空闲'}</span>
        </div>

        <div class="summary-grid">
          <div class="summary-card">
            <span>当前分支</span>
            <strong>{branch || '未选择'}</strong>
          </div>
          <div class="summary-card">
            <span>域名数量</span>
            <strong>{domains.filter((item) => item.ip.trim()).length}</strong>
          </div>
          <div class="summary-card">
            <span>最近日志</span>
            <strong>{getLatestLogEntry() ? new Date(getLatestLogEntry().timestamp).toLocaleTimeString() : '--:--:--'}</strong>
          </div>
          <div class="summary-card">
            <span>失败上传</span>
            <strong>{uploadFields.filter(({ key }) => uploadStates[key].status === 'error').length}</strong>
          </div>
        </div>

        <div class="summary-note">
          <span class="summary-note-label">当前提示</span>
          <p>{getBuildSummaryText()}</p>
        </div>
      </section>

      <section class="panel build-log-panel">
        <div class="panel-heading">
          <div>
            <p class="panel-kicker">Realtime</p>
            <h2>打包日志</h2>
          </div>
          <span class="build-log-room">{activeRoomId || '等待任务'}</span>
        </div>

        <div class="build-log-list">
          {#if buildLogs.length === 0}
            <div class="build-log-empty">提交配置后，实时打包日志会出现在这里。</div>
          {:else}
            {#each buildLogs as log}
              <div class={`build-log-line ${log.level || 'info'}`}>
                <span class="build-log-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
                <span>{log.message}</span>
              </div>
            {/each}
          {/if}
        </div>
      </section>

      <section class="panel artifact-panel">
        <div class="panel-heading">
          <div>
            <p class="panel-kicker">Deliverables</p>
            <h2>已完成打包</h2>
          </div>
          <button type="button" class="btn-secondary compact" onclick={loadBuildArtifacts} disabled={loadingArtifacts}>
            {loadingArtifacts ? '刷新中...' : '刷新列表'}
          </button>
        </div>

        <div class="artifact-list">
          {#if buildArtifacts.length === 0}
            <div class="artifact-empty">暂无已完成打包记录</div>
          {:else}
            {#each buildArtifacts as item}
              <div class="artifact-card">
                <div class="artifact-title">{item.appName || '未命名应用'} {item.version ? `v${item.version}` : ''}</div>
                <div class="artifact-row">分支: {item.branch || '-'}</div>
                <div class="artifact-row">房间: {item.roomId || '-'}</div>
                <div class="artifact-row">构建时间: {item.createdAt ? new Date(item.createdAt).toLocaleString() : '-'}</div>
                <div class="artifact-row">包大小: {item.packageSize || 0} bytes</div>
                <div class="artifact-row">包路径: {item.packagePath || '-'}</div>
                <div class="artifact-row">下载地址: <a href={item.downloadUrl} target="_blank" rel="noreferrer">{item.downloadUrl}</a></div>
              </div>
            {/each}
          {/if}
        </div>
      </section>
    </aside>
  </div>
</main>

<style>
  :global(body) {
    margin: 0;
    min-height: 100vh;
    font-family: 'Avenir Next', 'PingFang SC', 'Helvetica Neue', sans-serif;
    background:
      radial-gradient(circle at top left, rgba(245, 158, 11, 0.18), transparent 28%),
      radial-gradient(circle at 85% 15%, rgba(14, 165, 233, 0.16), transparent 22%),
      linear-gradient(180deg, #f7f4ed 0%, #eef3f9 42%, #f8fbff 100%);
    color: #18253d;
  }

  :global(body)::before {
    content: '';
    position: fixed;
    inset: 0;
    pointer-events: none;
    background-image: linear-gradient(rgba(24, 37, 61, 0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(24, 37, 61, 0.035) 1px, transparent 1px);
    background-size: 36px 36px;
    mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.35), transparent 78%);
  }

  .page-shell {
    max-width: 1440px;
    margin: 0 auto;
    padding: 2rem clamp(1rem, 2vw, 2rem) 3rem;
  }

  .hero-panel {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .hero-copy,
  .hero-metrics,
  .panel,
  .message-banner {
    position: relative;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.65);
    border-radius: 24px;
    background: rgba(255, 255, 255, 0.8);
    box-shadow: 0 20px 50px rgba(20, 35, 64, 0.08);
    backdrop-filter: blur(18px);
  }

  .hero-copy {
    padding: clamp(1.5rem, 3vw, 2.4rem);
    min-height: 210px;
    background:
      radial-gradient(circle at top right, rgba(14, 165, 233, 0.14), transparent 35%),
      linear-gradient(135deg, rgba(255, 255, 255, 0.95), rgba(252, 244, 224, 0.95));
  }

  .hero-copy::after {
    content: '';
    position: absolute;
    width: 180px;
    height: 180px;
    right: -30px;
    bottom: -60px;
    border-radius: 32px;
    background: linear-gradient(135deg, rgba(245, 158, 11, 0.18), rgba(14, 165, 233, 0.08));
    transform: rotate(18deg);
  }

  .eyebrow,
  .panel-kicker,
  .metric-label,
  .summary-note-label {
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 0.72rem;
    font-weight: 700;
    color: #8b6c19;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    margin-top: 0.6rem;
    max-width: 10ch;
    font-size: clamp(2rem, 4vw, 3.6rem);
    line-height: 0.98;
    letter-spacing: -0.05em;
  }

  .hero-text {
    margin-top: 1rem;
    max-width: 44rem;
    font-size: 1rem;
    line-height: 1.75;
    color: #42526e;
  }

  .hero-metrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.9rem;
    padding: 1rem;
  }

  .metric-card {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 0.6rem;
    min-height: 112px;
    padding: 1rem;
    border-radius: 20px;
    background: linear-gradient(180deg, rgba(248, 251, 255, 0.95), rgba(236, 243, 252, 0.9));
    border: 1px solid rgba(125, 151, 180, 0.15);
  }

  .metric-card.accent {
    background: linear-gradient(135deg, #1f4b99, #2563eb);
    color: #f8fbff;
  }

  .metric-card.accent .metric-label {
    color: rgba(255, 255, 255, 0.72);
  }

  .metric-value {
    font-size: 1.55rem;
    line-height: 1.1;
    letter-spacing: -0.04em;
  }

  .room-id {
    word-break: break-all;
    font-size: 1.05rem;
    line-height: 1.4;
    letter-spacing: 0;
  }

  .message-banner {
    margin-bottom: 1rem;
    padding: 0.95rem 1.15rem;
    font-size: 0.95rem;
  }

  .message-banner.success {
    border-color: rgba(5, 150, 105, 0.18);
    background: rgba(209, 250, 229, 0.82);
    color: #065f46;
  }

  .message-banner.error {
    border-color: rgba(220, 38, 38, 0.18);
    background: rgba(254, 226, 226, 0.88);
    color: #991b1b;
  }

  .message-banner.info {
    border-color: rgba(37, 99, 235, 0.16);
    background: rgba(219, 234, 254, 0.86);
    color: #1e40af;
  }

  .workspace-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.28fr) minmax(320px, 0.92fr);
    gap: 1rem;
    align-items: start;
  }

  .editor-column,
  .insight-column {
    display: grid;
    gap: 1rem;
  }

  .config-form {
    display: grid;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    gap: 1rem;
  }

  .panel {
    padding: 1.2rem;
  }

  .panel-basic {
    grid-column: span 7;
  }

  .panel-domain {
    grid-column: span 5;
  }

  .panel-upload,
  .panel-actions {
    grid-column: 1 / -1;
  }

  .panel-heading {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .panel-heading h2 {
    margin-top: 0.28rem;
    font-size: 1.25rem;
    letter-spacing: -0.03em;
  }

  .panel-note {
    font-size: 0.86rem;
    color: #64748b;
  }

  .field-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.9rem;
  }

  .field {
    min-width: 0;
  }

  .field-span-2 {
    grid-column: span 2;
  }

  label {
    display: block;
    margin-bottom: 0.42rem;
    font-size: 0.9rem;
    font-weight: 700;
    color: #24324a;
  }

  .required {
    color: #dc2626;
  }

  input[type='text'],
  input[type='number'],
  select {
    width: 100%;
    padding: 0.82rem 0.95rem;
    border: 1px solid rgba(148, 163, 184, 0.45);
    border-radius: 16px;
    box-sizing: border-box;
    font-size: 0.96rem;
    background: rgba(255, 255, 255, 0.92);
    color: #18253d;
    transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
  }

  input[type='text']:focus,
  input[type='number']:focus,
  select:focus {
    outline: none;
    border-color: rgba(37, 99, 235, 0.9);
    box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.12);
    transform: translateY(-1px);
  }

  input[type='file'] {
    width: 100%;
    font-size: 0.9rem;
  }

  .domain-list {
    display: grid;
    gap: 0.75rem;
  }

  .domain-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto 120px 42px;
    align-items: center;
    gap: 0.6rem;
  }

  .separator {
    font-weight: 700;
    color: #64748b;
  }

  .upload-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.9rem;
  }

  .upload-card {
    padding: 1rem;
    border-radius: 20px;
    border: 1px solid rgba(148, 163, 184, 0.16);
    background: linear-gradient(180deg, rgba(248, 250, 252, 0.95), rgba(255, 255, 255, 0.92));
  }

  .upload-card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.8rem;
    margin-bottom: 0.55rem;
  }

  .upload-meta,
  .file-link {
    display: block;
    margin-top: 0.55rem;
    font-size: 0.83rem;
    color: #5b6b83;
    word-break: break-all;
  }

  .file-link a,
  .artifact-row a {
    color: #2563eb;
  }

  .progress-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.85rem;
  }

  .progress-track {
    flex: 1;
    height: 10px;
    overflow: hidden;
    border-radius: 999px;
    background: #dbeafe;
  }

  .progress-fill {
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, #2563eb, #0ea5e9);
    transition: width 0.2s ease;
  }

  .progress-text {
    min-width: 42px;
    font-size: 0.84rem;
    font-weight: 700;
    text-align: right;
    color: #1d4ed8;
  }

  .upload-status {
    margin-top: 0.6rem;
    font-size: 0.85rem;
    font-weight: 700;
  }

  .upload-status.uploading {
    color: #1d4ed8;
  }

  .upload-status.success {
    color: #047857;
  }

  .upload-status.error {
    color: #b91c1c;
  }

  .upload-status.idle {
    color: #64748b;
  }

  .btn-primary,
  .btn-query,
  .btn-secondary,
  .btn-remove,
  .btn-text {
    border: none;
    cursor: pointer;
    transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
  }

  .btn-primary:hover:not(:disabled),
  .btn-query:hover:not(:disabled),
  .btn-secondary:hover:not(:disabled),
  .btn-remove:hover:not(:disabled),
  .btn-text:hover:not(:disabled) {
    transform: translateY(-1px);
  }

  .btn-primary,
  .btn-query {
    min-width: 168px;
    padding: 0.95rem 1.3rem;
    border-radius: 999px;
    color: #fff;
    font-size: 0.96rem;
    font-weight: 700;
  }

  .btn-primary {
    background: linear-gradient(135deg, #1d4ed8, #0f766e);
    box-shadow: 0 14px 30px rgba(29, 78, 216, 0.22);
  }

  .btn-query {
    background: linear-gradient(135deg, #f59e0b, #ea580c);
    box-shadow: 0 14px 30px rgba(234, 88, 12, 0.2);
  }

  .btn-primary:disabled,
  .btn-query:disabled,
  .btn-secondary:disabled,
  .btn-remove:disabled {
    opacity: 0.55;
    cursor: not-allowed;
    box-shadow: none;
    transform: none;
  }

  .btn-secondary {
    padding: 0.72rem 1rem;
    border-radius: 999px;
    background: #edf2f7;
    color: #24324a;
    font-size: 0.86rem;
    font-weight: 700;
  }

  .btn-secondary.compact {
    padding: 0.62rem 0.95rem;
  }

  .btn-remove {
    width: 42px;
    height: 42px;
    border-radius: 14px;
    background: #fee2e2;
    color: #b91c1c;
    font-size: 0.9rem;
  }

  .btn-text {
    padding: 0;
    background: transparent;
    color: #2563eb;
    font-size: 0.84rem;
    font-weight: 700;
  }

  .panel-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    background: linear-gradient(135deg, rgba(255, 248, 235, 0.92), rgba(237, 247, 255, 0.92));
  }

  .submit-copy {
    max-width: 34rem;
  }

  .submit-copy p:last-child {
    margin-top: 0.5rem;
    color: #42526e;
    line-height: 1.7;
  }

  .actions {
    display: flex;
    gap: 0.85rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    padding: 0.45rem 0.8rem;
    background: #dbeafe;
    color: #1d4ed8;
    font-size: 0.8rem;
    font-weight: 700;
    white-space: nowrap;
  }

  .status-pill.error {
    background: #fee2e2;
    color: #b91c1c;
  }

  .status-pill.warning {
    background: #fef3c7;
    color: #b45309;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }

  .summary-card {
    padding: 0.95rem;
    border-radius: 18px;
    background: linear-gradient(180deg, #f8fbff, #eef5fb);
    border: 1px solid rgba(148, 163, 184, 0.14);
  }

  .summary-card span {
    display: block;
    margin-bottom: 0.35rem;
    font-size: 0.82rem;
    color: #64748b;
  }

  .summary-card strong {
    display: block;
    font-size: 1.05rem;
    color: #18253d;
    word-break: break-word;
  }

  .summary-note {
    margin-top: 0.9rem;
    padding: 1rem;
    border-radius: 18px;
    background: rgba(255, 248, 235, 0.85);
  }

  .summary-note p {
    margin-top: 0.45rem;
    color: #48556c;
    line-height: 1.7;
  }

  .build-log-room {
    max-width: 180px;
    font-size: 0.8rem;
    font-weight: 700;
    color: #64748b;
    text-align: right;
    word-break: break-all;
  }

  .build-log-list,
  .result-panel pre {
    border-radius: 20px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .build-log-list {
    max-height: 520px;
    overflow-y: auto;
    padding: 0.9rem;
    background: linear-gradient(180deg, #081120, #0f172a);
    color: #dbe6f5;
  }

  .build-log-empty {
    color: #8ea1bd;
    font-size: 0.86rem;
  }

  .build-log-line {
    display: flex;
    gap: 0.65rem;
    padding: 0.2rem 0;
    font-size: 0.82rem;
    line-height: 1.5;
    word-break: break-word;
  }

  .build-log-line.error {
    color: #fca5a5;
  }

  .build-log-line.warning {
    color: #fde68a;
  }

  .build-log-time {
    min-width: 72px;
    flex-shrink: 0;
    color: #7dd3fc;
  }

  .artifact-list {
    display: grid;
    gap: 0.8rem;
    margin-top: 0.2rem;
  }

  .artifact-card {
    padding: 1rem;
    border-radius: 18px;
    border: 1px solid rgba(96, 165, 250, 0.16);
    background: linear-gradient(180deg, rgba(248, 251, 255, 0.96), rgba(236, 245, 255, 0.92));
  }

  .artifact-title {
    margin-bottom: 0.5rem;
    font-size: 1rem;
    font-weight: 800;
    color: #1d4ed8;
  }

  .artifact-row {
    margin-bottom: 0.24rem;
    font-size: 0.9rem;
    color: #334155;
    word-break: break-all;
  }

  .artifact-empty {
    font-size: 0.9rem;
    color: #64748b;
  }

  .result-panel pre {
    margin-top: 0.2rem;
    overflow-x: auto;
    padding: 1rem;
    background: #0f172a;
    color: #e2e8f0;
    font-size: 0.84rem;
    line-height: 1.55;
  }

  @media (max-width: 1180px) {
    .hero-panel,
    .workspace-grid {
      grid-template-columns: 1fr;
    }

    .panel-basic,
    .panel-domain {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 780px) {
    .page-shell {
      padding: 1rem 0.8rem 2rem;
    }

    .hero-metrics,
    .upload-grid,
    .summary-grid,
    .field-grid {
      grid-template-columns: 1fr;
    }

    .field-span-2 {
      grid-column: span 1;
    }

    .panel-actions,
    .panel-heading,
    .domain-row {
      display: flex;
      flex-direction: column;
      align-items: stretch;
    }

    .actions {
      justify-content: stretch;
    }

    .btn-primary,
    .btn-query,
    .btn-secondary.compact {
      width: 100%;
    }

    .build-log-room {
      max-width: none;
      text-align: left;
    }
  }
</style>
