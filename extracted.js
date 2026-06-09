
    // HTML 转义工具
    function escapeHtml(s) {
      return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function escapeAttr(s) {
      return escapeHtml(s);
    }

    // 全局错误捕获，避免静默失败
    window.addEventListener('error', function(e) {
      console.error('[dimilinks-demo] error:', e.message, e.filename, e.lineno);
      const bar = document.getElementById('statusBar');
      if (bar) {
        bar.className = 'status-bar error';
        bar.textContent = '页面错误: ' + e.message;
      }
    });

    const BASE_URL = 'https://dimilinks.com/v1';
    let pollTimer = null;
    let history = JSON.parse(localStorage.getItem('dimilinks_history') || '[]');

    // Size select handler
    document.getElementById('size').addEventListener('change', function() {
      document.getElementById('customSizeRow').style.display =
        this.value === 'custom' ? 'grid' : 'none';
    });

    // Async toggle
    document.getElementById('asyncMode').addEventListener('change', function() {
      document.getElementById('pollSection').style.display = this.checked ? 'block' : 'none';
    });

    // API key visibility
    function toggleKeyVisibility() {
      const input = document.getElementById('apiKey');
      input.type = input.type === 'password' ? 'text' : 'password';
    }

    // Reference images
    function addRefImage() {
      const container = document.getElementById('refImages');
      const count = container.children.length;
      if (count >= 4) return alert('最多4张参考图');
      const row = document.createElement('div');
      row.className = 'ref-image-row';
      row.innerHTML = `
        <input type="text" placeholder="图片 URL 或 data:image/...;base64,..." class="ref-url">
        <button class="remove-btn" onclick="this.parentElement.remove()" title="移除">&times;</button>
      `;
      container.appendChild(row);
    }

    // ===== 梦境解读 =====
    const INTERPRET_SYSTEM = `你是一位温和、专业的梦境研究者，熟悉荣格、弗洛伊德及现代积极心理学。
请基于用户提供的「梦境画面描述」(即给图像生成模型的 prompt)，输出一份结构化的中文解读。
要求：
1. 不要做医学诊断，不要暗示现实事件。
2. 关注画面中的象征物、颜色、场景、情绪氛围。
3. 给出可能的潜意识主题、情绪提示、可以自问的小问题。
4. 文字简洁、有温度，便于复制分享。
严格使用以下 Markdown 结构（不要使用代码块包裹，直接输出 Markdown）：
## 画面概览
（1-2 句）
## 关键象征
- 象征1：可能含义
- 象征2：可能含义
- 象征3：可能含义
## 情绪与主题
（2-3 句）
## 自我探索
- 问题1
- 问题2
- 问题3`;

    function setInterpretStatus(text, type) {
      const el = document.getElementById('interpretStatus');
      el.textContent = text;
      el.style.color = type === 'error' ? 'var(--error)'
                    : type === 'success' ? 'var(--success)'
                    : type === 'loading' ? 'var(--accent2)'
                    : 'var(--text2)';
    }

    function clearInterpretation() {
      document.getElementById('interpretResult').style.display = 'none';
      document.getElementById('interpretResult').innerHTML = '';
      setInterpretStatus('基于当前 Prompt 用 LLM 给出心理学角度的象征、情绪与可能含义。', 'idle');
    }

    function renderInterpretMarkdown(md) {
      // 极简 Markdown 渲染：仅支持 ## 标题、- 列表、段落
      const lines = String(md).split(/\r?\n/);
      let html = '';
      let inList = false;
      for (const line of lines) {
        const t = line.trim();
        if (/^##\s+/.test(t)) {
          if (inList) { html += '</ul>'; inList = false; }
          html += `<h4>${escapeHtml(t.replace(/^##\s+/, ''))}</h4>`;
        } else if (/^[-*]\s+/.test(t)) {
          if (!inList) { html += '<ul>'; inList = true; }
          html += `<li>${escapeHtml(t.replace(/^[-*]\s+/, ''))}</li>`;
        } else if (t === '') {
          if (inList) { html += '</ul>'; inList = false; }
        } else {
          if (inList) { html += '</ul>'; inList = false; }
          html += `<p>${escapeHtml(t)}</p>`;
        }
      }
      if (inList) html += '</ul>';
      return html;
    }

    async function interpretDream() {
      const apiKey = document.getElementById('apiKey').value.trim();
      const prompt = document.getElementById('prompt').value.trim();
      if (!apiKey) {
        setInterpretStatus('请先填写 API Key', 'error');
        return;
      }
      if (!prompt) {
        setInterpretStatus('请先填写 Prompt（梦境画面描述）', 'error');
        return;
      }

      const btn = document.getElementById('interpretBtn');
      btn.disabled = true;
      btn.textContent = '解读中...';
      setInterpretStatus('正在调用 LLM 解读...', 'loading');

      try {
        const res = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'deepseek-v4-flash',
            messages: [
              { role: 'system', content: INTERPRET_SYSTEM },
              { role: 'user', content: prompt }
            ],
            temperature: 0.7
          })
        });
        const data = await res.json();

        if (!res.ok) {
          setInterpretStatus(`请求失败 (${res.status}): ${data.error?.message || '未知错误'}`, 'error');
          return;
        }

        const text = data.choices?.[0]?.message?.content
          || data.choices?.[0]?.text
          || JSON.stringify(data, null, 2);

        const resultEl = document.getElementById('interpretResult');
        resultEl.innerHTML = renderInterpretMarkdown(text);
        resultEl.style.display = 'block';
        setInterpretStatus('解读完成', 'success');
      } catch (err) {
        setInterpretStatus(`请求异常: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '解读 Prompt';
      }
    }

    // Build request body
    function buildRequestBody() {
      const body = {
        model: document.getElementById('model').value || 'gpt-image-2',
        prompt: document.getElementById('prompt').value,
        n: parseInt(document.getElementById('n').value) || 1,
      };

      const sizeVal = document.getElementById('size').value;
      if (sizeVal === 'custom') {
        const w = document.getElementById('customWidth').value;
        const h = document.getElementById('customHeight').value;
        if (w && h) body.size = `${w}x${h}`;
      } else {
        body.size = sizeVal;
      }

      const resolution = document.getElementById('resolution').value;
      if (resolution) body.resolution = resolution;

      const outputFormat = document.getElementById('outputFormat').value;
      if (outputFormat) body.output_format = outputFormat;

      const background = document.getElementById('background').value;
      if (background) body.background = background;

      const moderation = document.getElementById('moderation').value;
      if (moderation) body.moderation = moderation;

      const user = document.getElementById('user').value;
      if (user) body.user = user;

      // Reference images
      const refUrls = Array.from(document.querySelectorAll('.ref-url'))
        .map(el => el.value.trim())
        .filter(Boolean);
      if (refUrls.length > 0) {
        body.image_urls = refUrls.length === 1 ? refUrls[0] : refUrls;
      }

      return body;
    }

    // Update status bar
    function setStatus(type, text) {
      const bar = document.getElementById('statusBar');
      bar.className = `status-bar ${type}`;
      if (type === 'loading') {
        bar.innerHTML = `<div class="spinner"></div>${text}`;
      } else {
        bar.textContent = text;
      }
    }

    // Show JSON with syntax highlighting
    function showJson(obj) {
      const el = document.getElementById('responseJson');
      const json = JSON.stringify(obj, null, 2);
      el.innerHTML = json
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"([^"]+)":/g, '<span class="key">"$1"</span>:')
        .replace(/: "([^"]*)"/g, ': <span class="string">"$1"</span>')
        .replace(/: (\d+)/g, ': <span class="number">$1</span>');
    }

    // Show images
    function showImages(data) {
      const container = document.getElementById('imageResult');
      if (!data || data.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="icon">&#127912;</div>暂无图片</div>';
        return;
      }

      container.innerHTML = '<div class="image-grid">' + data.map((item, i) => {
        let imgSrc = item.url || '';
        // Relative URL -> absolute
        if (imgSrc.startsWith('/')) {
          imgSrc = BASE_URL.replace('/v1', '') + imgSrc;
        }
        return `
          <div class="image-card">
            <img src="${imgSrc}" alt="Generated ${i + 1}" onclick="openOverlay('${imgSrc.replace(/'/g, "\\'")}')"
                 onerror="this.alt='加载失败'; this.style.minHeight='120px'; this.style.background='var(--surface2)';">
            <div class="meta">
              <span>#${i + 1}</span>
              ${item.file_id ? `<span>file: ${item.file_id}</span>` : ''}
              <a href="${imgSrc}" target="_blank" download>打开</a>
            </div>
          </div>
        `;
      }).join('') + '</div>';
    }

    // Image overlay
    function openOverlay(src) {
      document.getElementById('overlayImg').src = src;
      document.getElementById('overlay').classList.add('active');
    }

    function closeOverlay() {
      document.getElementById('overlay').classList.remove('active');
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeOverlay();
    });

    // Polling
    function startPolling(taskId) {
      stopPolling();
      const interval = (parseInt(document.getElementById('pollInterval').value) || 3) * 1000;
      document.getElementById('stopPollBtn').disabled = false;

      pollTimer = setInterval(async () => {
        try {
          const res = await fetch(`${BASE_URL}/tasks/${taskId}`, {
            headers: { 'Authorization': `Bearer ${document.getElementById('apiKey').value}` }
          });
          const data = await res.json();

          if (!res.ok) {
            setStatus('error', `查询失败: ${data.error?.message || res.status}`);
            showJson(data);
            stopPolling();
            return;
          }

          showJson(data);
          updateTaskInfo(data);

          if (data.status === 'succeeded') {
            setStatus('success', `完成 — task_id: ${taskId}`);
            showImages(data.result?.data || []);
            stopPolling();
            updateHistoryStatus(taskId, 'succeeded');
          } else if (data.status === 'failed') {
            setStatus('error', `失败 — ${data.error?.message || '未知错误'}`);
            stopPolling();
            updateHistoryStatus(taskId, 'failed');
          } else {
            const progress = data.progress || 0;
            setStatus('loading', `生成中 ${progress}% — ${data.status}`);
          }
        } catch (err) {
          setStatus('error', `轮询异常: ${err.message}`);
          stopPolling();
        }
      }, interval);
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      document.getElementById('stopPollBtn').disabled = true;
    }

    function updateTaskInfo(data) {
      const el = document.getElementById('taskInfo');
      el.style.display = 'block';
      el.innerHTML = `
        <div class="task-info">
          <div class="field"><span class="k">Task ID</span><span class="v">${data.task_id || data.id || '-'}</span></div>
          <div class="field"><span class="k">Status</span><span class="v">${data.status || '-'}</span></div>
          <div class="field"><span class="k">Progress</span><span class="v">${data.progress ?? '-'}%</span></div>
          ${data.created_at ? `<div class="field"><span class="k">Created</span><span class="v">${new Date(data.created_at * 1000).toLocaleString()}</span></div>` : ''}
          ${data.completed_at ? `<div class="field"><span class="k">Completed</span><span class="v">${new Date(data.completed_at * 1000).toLocaleString()}</span></div>` : ''}
        </div>
        ${data.progress !== undefined ? `<div class="progress-bar"><div class="fill" style="width:${data.progress}%"></div></div>` : ''}
      `;
    }

    // Submit
    async function submitGeneration() {
      const apiKey = document.getElementById('apiKey').value.trim();
      if (!apiKey) return alert('请输入 API Key');
      const prompt = document.getElementById('prompt').value.trim();
      if (!prompt) return alert('请输入 Prompt');

      const isAsync = document.getElementById('asyncMode').checked;
      const body = buildRequestBody();

      const submitBtn = document.getElementById('submitBtn');
      submitBtn.disabled = true;
      submitBtn.textContent = '提交中...';

      const url = isAsync
        ? `${BASE_URL}/images/generations?async=true`
        : `${BASE_URL}/images/generations`;

      try {
        setStatus('loading', '正在提交请求...');
        showJson({ url, method: 'POST', body });

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });

        const data = await res.json();
        showJson(data);

        if (!res.ok) {
          setStatus('error', `请求失败 (${res.status}): ${data.error?.message || '未知错误'}`);
          return;
        }

        const taskId = data.task_id;

        if (isAsync && data.data && data.data.length === 0) {
          // Async submitted, start polling
          setStatus('loading', `已提交 — task_id: ${taskId}，开始轮询...`);
          updateTaskInfo({ task_id: taskId, status: 'queued', progress: 0 });
          addHistory(prompt, taskId);
          startPolling(taskId);
        } else {
          // Sync response or async with immediate result
          setStatus('success', `完成 — task_id: ${taskId}`);
          showImages(data.data || []);
          addHistory(prompt, taskId, 'succeeded');
        }
      } catch (err) {
        setStatus('error', `请求异常: ${err.message}`);
        showJson({ error: err.message });
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '生成图片';
      }
    }

    // History
    function addHistory(prompt, taskId, status = 'pending') {
      history.unshift({
        prompt,
        taskId,
        status,
        time: Date.now()
      });
      if (history.length > 20) history = history.slice(0, 20);
      localStorage.setItem('dimilinks_history', JSON.stringify(history));
      renderHistory();
    }

    function updateHistoryStatus(taskId, status) {
      const item = history.find(h => h.taskId === taskId);
      if (item) item.status = status;
      localStorage.setItem('dimilinks_history', JSON.stringify(history));
      renderHistory();
    }

    function clearHistory() {
      history = [];
      localStorage.removeItem('dimilinks_history');
      renderHistory();
    }

    function renderHistory() {
      const el = document.getElementById('historyList');
      if (history.length === 0) {
        el.innerHTML = '<div class="empty-state"><div class="icon">&#128203;</div>暂无记录</div>';
        return;
      }
      el.innerHTML = history.map(h => {
        const statusIcon = h.status === 'succeeded' ? '&#9989;' : h.status === 'failed' ? '&#10060;' : '&#9203;';
        const time = new Date(h.time).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
        return `
          <div class="history-item" onclick="loadHistory('${escapeAttr(h.taskId)}')">
            <div class="prompt-text">${statusIcon} ${escapeHtml(h.prompt)}</div>
            <div class="prompt-meta">${escapeHtml(h.taskId)} · ${time}</div>
          </div>
        `;
      }).join('');
    }

    async function loadHistory(taskId) {
      const apiKey = document.getElementById('apiKey').value.trim();
      if (!apiKey) return alert('请先输入 API Key');

      setStatus('loading', `查询任务 ${taskId}...`);
      try {
        const res = await fetch(`${BASE_URL}/tasks/${taskId}`, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        const data = await res.json();
        showJson(data);
        updateTaskInfo(data);

        if (data.status === 'succeeded') {
          setStatus('success', `任务已完成 — ${taskId}`);
          showImages(data.result?.data || []);
        } else if (data.status === 'failed') {
          setStatus('error', `任务失败 — ${data.error?.message || '未知'}`);
        } else {
          setStatus('loading', `任务进行中 — ${data.status} ${data.progress || 0}%`);
          startPolling(taskId);
        }
      } catch (err) {
        setStatus('error', `查询异常: ${err.message}`);
      }
    }

    // Init
    renderHistory();

    // Auto-load API key from localStorage
    const savedKey = localStorage.getItem('dimilinks_api_key');
    if (savedKey) document.getElementById('apiKey').value = savedKey;

    document.getElementById('apiKey').addEventListener('change', function() {
      localStorage.setItem('dimilinks_api_key', this.value);
    });
  