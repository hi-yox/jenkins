<script>
  import { uploadFiles, saveConfig, getConfig, getBranches } from './api.js';

  let appName = $state('');
  let opKey = $state('');
  let requestHttp = $state('');
  let version = $state('');
  let branch = $state('');
  let branches = $state([]);
  let domains = $state([{ ip: '', port: 443 }]);

  // 加载分支列表
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

  // 文件
  let iconFile = $state(null);
  let launchScreenFile = $state(null);
  let certFile = $state(null);

  // 上传结果
  let iconUrl = $state('');
  let launchScreenUrl = $state('');
  let certUrl = $state('');

  // 状态
  let submitting = $state(false);
  let message = $state('');
  let messageType = $state('');
  let queriedConfig = $state(null);
  let querying = $state(false);

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
    setTimeout(() => { message = ''; }, 5000);
  }

  async function handleSubmit() {
    if (!appName.trim()) {
      showMessage('请填写应用名称', 'error');
      return;
    }

    submitting = true;
    message = '';

    try {
      // 1. 上传文件
      const filesToUpload = [];
      const fileLabels = [];

      if (iconFile) {
        filesToUpload.push(iconFile);
        fileLabels.push('icon');
      }
      if (launchScreenFile) {
        filesToUpload.push(launchScreenFile);
        fileLabels.push('LaunchScreen');
      }
      if (certFile) {
        filesToUpload.push(certFile);
        fileLabels.push('cert');
      }

      let uploadedFiles = {};
      if (filesToUpload.length > 0) {
        const result = await uploadFiles(filesToUpload);
        result.files.forEach((f, i) => {
          uploadedFiles[fileLabels[i]] = f.downloadUrl;
        });

        if (uploadedFiles['icon']) iconUrl = uploadedFiles['icon'];
        if (uploadedFiles['LaunchScreen']) launchScreenUrl = uploadedFiles['LaunchScreen'];
        if (uploadedFiles['cert']) certUrl = uploadedFiles['cert'];
      }

      // 2. 保存配置
      const config = {
        appName: appName.trim(),
        opKey: opKey.trim(),
        requestHttp: requestHttp.trim(),
        version: version.trim(),
        branch: branch.trim(),
        domain: domains.filter(d => d.ip.trim()),
        icon: uploadedFiles['icon'] || iconUrl || '',
        LaunchScreen: uploadedFiles['LaunchScreen'] || launchScreenUrl || '',
        cert: uploadedFiles['cert'] || certUrl || ''
      };

      await saveConfig(config);
      showMessage('配置提交成功！', 'success');
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

      <div class="field">
        <label for="iconFile">图标 ZIP 文件</label>
        <input id="iconFile" type="file" accept=".zip" onchange={(e) => iconFile = e.target.files[0] || null} />
        {#if iconUrl}
          <span class="file-link">已上传: <a href={iconUrl} target="_blank" rel="noreferrer">{iconUrl}</a></span>
        {/if}
      </div>

      <div class="field">
        <label for="launchScreenFile">启动图文件</label>
        <input id="launchScreenFile" type="file" accept=".jpg,.jpeg,.png" onchange={(e) => launchScreenFile = e.target.files[0] || null} />
        {#if launchScreenUrl}
          <span class="file-link">已上传: <a href={launchScreenUrl} target="_blank" rel="noreferrer">{launchScreenUrl}</a></span>
        {/if}
      </div>

      <div class="field">
        <label for="certFile">证书文件</label>
        <input id="certFile" type="file" accept=".mobileprovision,.p12,.cer,.pem" onchange={(e) => certFile = e.target.files[0] || null} />
        {#if certUrl}
          <span class="file-link">已上传: <a href={certUrl} target="_blank" rel="noreferrer">{certUrl}</a></span>
        {/if}
      </div>


    </section>

    <div class="actions">
      <button type="submit" class="btn-primary" disabled={submitting}>
        {submitting ? '提交中...' : '提交配置'}
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
  }

  .file-link {
    display: block;
    margin-top: 0.3rem;
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
</style>
