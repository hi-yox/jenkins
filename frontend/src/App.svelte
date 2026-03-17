<script>
  import { onDestroy } from 'svelte';
  import { io } from 'socket.io-client';
  import { uploadFile, saveConfig, getConfig, getBranches, getBuildLogs, SOCKET_BASE } from './api.js';

  const uploadFields = [
    { key: 'icon', inputId: 'iconFile', label: '图标 ZIP 文件', accept: '.zip' },
    { key: 'LaunchScreen', inputId: 'launchScreenFile', label: '启动图文件', accept: '.jpg,.jpeg,.png' },
    { key: 'cert', inputId: 'certFile', label: '证书文件', accept: '.mobileprovision,.p12,.cer,.pem' }
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
    cert: createUploadState()
  });
  let uploadInputKeys = $state({
    icon: 0,
    LaunchScreen: 0,
    cert: 0
  });

  let submitting = $state(false);
  let message = $state('');
  let messageType = $state('');
  let queriedConfig = $state(null);
  let querying = $state(false);
  let activeRoomId = $state('');
  let buildLogs = $state([]);

  let socket = null;

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

  function connectLogRoom(roomId) {
    if (!roomId) {
      return;
    }

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    socket = io(SOCKET_BASE, {
      transports: ['websocket', 'polling']
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

    socket.on('build-log', (payload) => {
      if (payload?.roomId !== roomId) {
        return;
      }

      pushBuildLog(payload);
    });

    socket.on('connect_error', (error) => {
      pushBuildLog({
        roomId,
        message: `[系统] 日志连接失败: ${error.message}`,
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

  $effect(() => { loadBranches(); });

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
    const roomId = crypto.randomUUID();

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
        cert: uploadStates.cert.url || ''
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
</script>

<main>
  <h1>📦 打包配置管理</h1>

  {#if message}
    <div class="message {messageType}">{message}</div>
  {/if}

  <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
    <section>
      <h2>基本信息</h2>

      <div class="field">
        <label for="appName">应用名称 <span class="required">*</span></label>
        <input id="appName" type="text" bind:value={appName} placeholder="例如: MyApp" required />
      </div>

      <div class="field">
        <label for="opKey">OpenInstall APP_KEY</label>
        <input id="opKey" type="text" bind:value={opKey} placeholder="openinstall 的 APP_KEY" />
      </div>

      <div class="field">
        <label for="requestHttp">请求地址 (requestHttp)</label>
        <input id="requestHttp" type="text" bind:value={requestHttp} placeholder="例如: https://api.example.com/config" />
      </div>

      <div class="field">
        <label for="version">版本号</label>
        <input id="version" type="text" bind:value={version} placeholder="例如: 1.0.0" />
      </div>

      <div class="field">
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
        <button type="button" class="btn-secondary" style="margin-top:0.3rem" onclick={loadBranches}>刷新分支</button>
      </div>
    </section>

    <section>
      <h2>域名列表</h2>
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
      <button type="button" class="btn-secondary" onclick={addDomain}>+ 添加域名</button>
    </section>

    <section>
      <h2>文件上传</h2>

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
          {/if}
        </div>
      {/each}
    </section>

    <div class="actions">
      <button type="submit" class="btn-primary" disabled={isSubmitDisabled()}>
        {getSubmitLabel()}
      </button>
      <button type="button" class="btn-query" onclick={handleQuery} disabled={querying}>
        {querying ? '查询中...' : '查询配置'}
      </button>
    </div>
  </form>

  {#if queriedConfig}
    <section class="result">
      <h2>查询结果</h2>
      <pre>{JSON.stringify(queriedConfig, null, 2)}</pre>
    </section>
  {/if}

  <section class="build-log-section">
    <h2>打包日志</h2>
    <div class="build-log-room">roomId: {activeRoomId || '未开始任务'}</div>
    <div class="build-log-list">
      {#if buildLogs.length === 0}
        <div class="build-log-empty">提交配置后将在这里显示实时打包日志</div>
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
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f5f7fa;
    color: #333;
  }

  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 2rem 1.5rem;
  }

  h1 {
    text-align: center;
    margin-bottom: 2rem;
    font-size: 1.8rem;
  }

  h2 {
    font-size: 1.2rem;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 2px solid #e2e8f0;
  }

  section {
    background: #fff;
    border-radius: 8px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .field {
    margin-bottom: 1rem;
  }

  label {
    display: block;
    font-weight: 600;
    margin-bottom: 0.4rem;
    font-size: 0.9rem;
  }

  .required {
    color: #e53e3e;
  }

  input[type="text"],
  input[type="number"],
  select {
    width: 100%;
    padding: 0.6rem 0.8rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 0.95rem;
    box-sizing: border-box;
    transition: border-color 0.2s;
  }

  input[type="text"]:focus,
  input[type="number"]:focus,
  select:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  input[type="file"] {
    font-size: 0.9rem;
    width: 100%;
  }

  .file-link {
    display: block;
    margin-top: 0.5rem;
    font-size: 0.8rem;
    color: #6b7280;
  }

  .file-link a {
    color: #3b82f6;
    word-break: break-all;
  }

  .domain-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .domain-ip {
    flex: 3;
  }

  .separator {
    font-weight: bold;
    font-size: 1.2rem;
  }

  .domain-port {
    flex: 1;
    min-width: 80px;
  }

  .btn-remove {
    background: #ef4444;
    color: white;
    border: none;
    border-radius: 6px;
    width: 32px;
    height: 32px;
    cursor: pointer;
    font-size: 0.9rem;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .btn-remove:hover {
    background: #dc2626;
  }

  .btn-secondary {
    background: #e2e8f0;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
    margin-top: 0.5rem;
  }

  .btn-secondary:hover {
    background: #cbd5e1;
  }

  .upload-card {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 1rem;
    background: #f8fafc;
  }

  .upload-card:last-child {
    margin-bottom: 0;
  }

  .upload-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.4rem;
  }

  .upload-meta {
    margin-top: 0.5rem;
    font-size: 0.85rem;
    color: #475569;
    word-break: break-all;
  }

  .progress-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .progress-track {
    flex: 1;
    height: 10px;
    background: #dbeafe;
    border-radius: 999px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #2563eb, #0ea5e9);
    border-radius: 999px;
    transition: width 0.2s ease;
  }

  .progress-text {
    min-width: 44px;
    font-size: 0.85rem;
    font-weight: 600;
    color: #1d4ed8;
    text-align: right;
  }

  .upload-status {
    margin-top: 0.55rem;
    font-size: 0.85rem;
    font-weight: 600;
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

  .btn-text {
    border: none;
    background: transparent;
    color: #2563eb;
    font-size: 0.85rem;
    cursor: pointer;
    padding: 0;
  }

  .btn-text:hover {
    color: #1d4ed8;
    text-decoration: underline;
  }

  .actions {
    display: flex;
    gap: 1rem;
    justify-content: center;
    margin-top: 1rem;
  }

  .btn-primary {
    background: #3b82f6;
    color: white;
    border: none;
    padding: 0.75rem 2rem;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }

  .btn-primary:hover:not(:disabled) {
    background: #2563eb;
  }

  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-query {
    background: #10b981;
    color: white;
    border: none;
    padding: 0.75rem 2rem;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }

  .btn-query:hover:not(:disabled) {
    background: #059669;
  }

  .btn-query:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .message {
    padding: 0.75rem 1rem;
    border-radius: 6px;
    margin-bottom: 1rem;
    font-size: 0.9rem;
  }

  .message.success {
    background: #d1fae5;
    color: #065f46;
  }

  .message.error {
    background: #fee2e2;
    color: #991b1b;
  }

  .message.info {
    background: #dbeafe;
    color: #1e40af;
  }

  .result {
    margin-top: 1rem;
  }

  .result pre {
    background: #1e293b;
    color: #e2e8f0;
    padding: 1rem;
    border-radius: 8px;
    overflow-x: auto;
    font-size: 0.85rem;
    line-height: 1.5;
  }

  .build-log-section {
    margin-bottom: 2rem;
  }

  .build-log-room {
    margin-bottom: 0.75rem;
    color: #334155;
    font-size: 0.9rem;
    word-break: break-all;
  }

  .build-log-list {
    background: #0f172a;
    color: #e2e8f0;
    border-radius: 8px;
    padding: 0.75rem;
    max-height: 360px;
    overflow-y: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .build-log-empty {
    color: #94a3b8;
    font-size: 0.85rem;
  }

  .build-log-line {
    display: flex;
    gap: 0.5rem;
    font-size: 0.82rem;
    line-height: 1.4;
    padding: 0.15rem 0;
    word-break: break-word;
  }

  .build-log-line.error {
    color: #fca5a5;
  }

  .build-log-time {
    color: #93c5fd;
    min-width: 70px;
    flex-shrink: 0;
  }
</style>
