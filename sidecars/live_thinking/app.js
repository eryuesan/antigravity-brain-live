(() => {
  const POLL_MS = 800;
  const $ = (id) => document.getElementById(id);

  const state = {
    etag: '',
    data: null,
    conversations: [],
    selectedConvId: '', // '' means follow active host conversation
    filter: 'thinking', // 'thinking' | 'all' | 'errors'
    query: '',
    paused: false,
    autoScroll: true,
    expandedSteps: new Set(),
    seenSteps: new Set(),
    initializedConvId: '',
    timer: null,
    convTick: 0,
  };

  // ---------- Helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return String(v);
  }

  function fmtLimit(n) {
    const v = Number(n) || 0;
    if (v === 1048576 || v === 1000000) return '1M';
    if (v === 2097152 || v === 2000000) return '2M';
    if (v === 512000 || v === 524288) return '512k';
    if (v === 256000 || v === 262144) return '256k';
    if (v === 200000) return '200k';
    if (v === 131072 || v === 128000) return '128k';
    return fmtTok(v);
  }

  function fmtClock(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return '';
    }
  }

  function fmtDelta(ms) {
    if (ms === null || ms === undefined || ms < 0) return '';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function highlightQuery(htmlText, q) {
    if (!q) return htmlText;
    const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${safeQ})`, 'gi');
    return htmlText.replace(/(<[^>]+>)|([^<]+)/g, (m, tag, txt) =>
      tag ? tag : txt.replace(re, '<mark>$1</mark>')
    );
  }

  function renderRichText(raw, query) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const blocks = [];
    const fencedRe = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
    let last = 0;
    let match;
    while ((match = fencedRe.exec(text)) !== null) {
      if (match.index > last) blocks.push({ type: 'md', text: text.slice(last, match.index) });
      blocks.push({ type: 'code', lang: match[1], text: match[2] });
      last = fencedRe.lastIndex;
    }
    if (last < text.length) blocks.push({ type: 'md', text: text.slice(last) });

    const html = blocks
      .map((b) => {
        if (b.type === 'code') {
          return `<pre><code>${esc(b.text)}</code></pre>`;
        }
        const lines = b.text.split(/\r?\n/);
        let out = '';
        let inUl = false;
        const formatInline = (line) =>
          esc(line)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

        for (const line of lines) {
          const li = line.match(/^\s*[-*•]\s+(.+)$/);
          if (li) {
            if (!inUl) {
              out += '<ul>';
              inUl = true;
            }
            out += `<li>${formatInline(li[1])}</li>`;
          } else {
            if (inUl) {
              out += '</ul>';
              inUl = false;
            }
            if (line.trim()) out += `<p>${formatInline(line)}</p>`;
          }
        }
        if (inUl) out += '</ul>';
        return out;
      })
      .join('');

    return highlightQuery(html, query);
  }

  function apiFetch(url) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    return f(url, { method: 'GET' });
  }

  function activeConvId() {
    return (
      state.selectedConvId ||
      window.sidecar?.conversationId ||
      new URLSearchParams(location.search).get('conversationId') ||
      ''
    );
  }

  function matchesFilter(step) {
    if (
      step.kind === 'planner' &&
      !step.thinking &&
      (!Array.isArray(step.toolCalls) || step.toolCalls.length === 0) &&
      !step.isError
    ) {
      return false;
    }
    if (state.filter === 'thinking') {
      return step.kind === 'planner' && Boolean(step.thinking);
    }
    if (state.filter === 'errors') {
      return Boolean(step.isError);
    }
    return true;
  }

  function matchesSearch(step, q) {
    if (!q) return true;
    const lower = q.toLowerCase();
    if (step.thinking && step.thinking.toLowerCase().includes(lower)) return true;
    if (step.kind !== 'planner' && step.content && step.content.toLowerCase().includes(lower)) return true;
    if (step.error && step.error.toLowerCase().includes(lower)) return true;
    if (Array.isArray(step.toolCalls)) {
      for (const tc of step.toolCalls) {
        if ((tc.name || '').toLowerCase().includes(lower)) return true;
        if ((tc.summary || '').toLowerCase().includes(lower)) return true;
      }
    }
    return false;
  }

  function renderConversationsSelect() {
    const sel = $('conv-select');
    const currentVal = state.selectedConvId;
    const hostId = window.sidecar?.conversationId || '';
    const opts = [
      `<option value="">自动跟随当前会话${hostId ? ` (${hostId.slice(0, 8)})` : ''}</option>`,
      ...state.conversations.map((c) => {
        const t = fmtClock(c.mtime);
        const label = `[${t}] ${c.title}`;
        return `<option value="${esc(c.id)}">${esc(label)}</option>`;
      }),
    ];
    sel.innerHTML = opts.join('');
    sel.value = currentVal;
  }

  function render(data, newlyAddedSteps = new Set()) {
    const feed = $('feed');
    if (!data || !data.found) {
      feed.innerHTML = `
        <div class="empty-state">
          <p>当前会话尚无本地思考日志，发送一条消息后这里会自动更新。</p>
        </div>
      `;
      return;
    }

    const st = data.stats || {};
    const usedTok = st.contextUsedTokens ?? st.latestInputTokens ?? 0;
    const limTok = st.contextLimit || (usedTok > 256000 ? 1048576 : 256000);
    const pct =
      st.contextUsedPercent !== undefined
        ? Number(st.contextUsedPercent) || 0
        : Math.min(100, (usedTok / limTok) * 100);
    const pctEl = $('ctx-pct');
    const fillEl = $('ctx-fill');
    if (pctEl) {
      pctEl.textContent = `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
      pctEl.classList.toggle('is-warn', pct >= 60 && pct < 85);
      pctEl.classList.toggle('is-danger', pct >= 85);
    }
    if ($('ctx-ratio')) {
      $('ctx-ratio').textContent = `${fmtTok(usedTok)} / ${fmtLimit(limTok)}`;
    }
    if (fillEl) {
      fillEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      fillEl.classList.toggle('is-warn', pct >= 60 && pct < 85);
      fillEl.classList.toggle('is-danger', pct >= 85);
    }

    $('st-thinking').textContent = String(st.thinkingSteps || 0);
    $('st-tools').textContent = String(st.toolCalls || 0);
    $('st-cache').textContent = `${st.cacheHitRatio || 0}%`;
    $('st-out').textContent = fmtTok(st.totalOutputTokens || 0);
    $('status-model').textContent = st.latestModel || 'unknown model';
    $('status-updated').textContent = `${fmtClock(data.updatedAt)} · ${data.isFullTranscript ? 'Full' : 'Compact'}`;

    const q = state.query.trim();
    const parts = [];

    for (const turn of data.turns || []) {
      const visibleSteps = (turn.steps || []).filter((s) => matchesFilter(s) && matchesSearch(s, q));
      if (visibleSteps.length === 0) continue;

      const stepHtml = visibleSteps
        .map((step) => {
          const isExpanded = state.expandedSteps.has(step.stepIndex);
          const isNew = newlyAddedSteps.has(step.stepIndex);
          const cardCls = [
            'step-card',
            step.thinking ? 'is-thinking' : '',
            step.isError ? 'is-error' : '',
            isExpanded ? 'expanded' : '',
            isNew ? 'is-new' : '',
          ]
            .filter(Boolean)
            .join(' ');

          let tagCls = 'sys';
          let tagLabel = step.type || step.kind;
          if (step.isError) {
            tagCls = 'err';
            tagLabel = 'ERROR';
          } else if (step.kind === 'planner' && step.thinking) {
            tagCls = 'think';
            tagLabel = `THINK #${step.stepIndex}`;
          } else if (step.kind === 'planner') {
            tagCls = 'sys';
            tagLabel = `TOOL #${step.stepIndex}`;
          } else if (step.kind === 'tool_result') {
            tagCls = 'tool';
            tagLabel = `RESULT #${step.stepIndex}`;
          }

          const delta = fmtDelta(step.deltaMs);
          const clock = fmtClock(step.createdAt);

          let bodyHtml = '';
          if (step.thinking) {
            bodyHtml += `<div class="thinking-text">${renderRichText(step.thinking, q)}</div>`;
          }
          if (Array.isArray(step.toolCalls) && step.toolCalls.length > 0) {
            bodyHtml += `<div class="tool-pills">${step.toolCalls
              .map(
                (tc) => `
                  <div class="tool-pill">
                    <div class="tool-pill-head" data-toggle-tool>
                      <span class="tool-name">${esc(tc.name)}</span>
                      <span class="tool-summary">${esc(tc.summary)}</span>
                    </div>
                    <pre class="tool-args">${esc(tc.argsPreview)}</pre>
                  </div>
                `
              )
              .join('')}</div>`;
          }
          if (step.content && step.kind !== 'planner') {
            bodyHtml += `<div class="raw-output">${esc(step.content)}</div>`;
          }
          if (step.error) {
            bodyHtml += `<div class="raw-output is-err-text">${esc(step.error)}</div>`;
          }
          if (step.tokens && (step.tokens.input > 0 || step.tokens.output > 0)) {
            bodyHtml += `<div class="token-meta">in ${fmtTok(step.tokens.input)} · cache ${fmtTok(step.tokens.cacheRead)} · out ${fmtTok(step.tokens.output)}</div>`;
          }

          return `
            <article class="${cardCls}" data-step="${step.stepIndex}">
              <div class="step-head" data-toggle-step="${step.stepIndex}">
                <div class="step-head-left">
                  <span class="chevron">▸</span>
                  <span class="step-tag ${tagCls}">${esc(tagLabel)}</span>
                </div>
                <div class="step-head-right">
                  ${delta ? `<span>+${esc(delta)}</span>` : ''}
                  ${clock ? `<span>${esc(clock)}</span>` : ''}
                  ${step.thinking ? `<button type="button" class="copy-btn" data-copy-step="${step.stepIndex}">复制</button>` : ''}
                </div>
              </div>
              <div class="step-body">${bodyHtml}</div>
            </article>
          `;
        })
        .join('');

      parts.push(`
        <section class="turn-group">
          <div class="turn-header" title="${esc(turn.userPrompt || '')}">
            <span class="turn-num">Turn ${turn.turnIndex}</span>
            <div class="turn-prompt">${esc(turn.userPrompt || '(系统/继续执行)')}</div>
          </div>
          ${stepHtml}
        </section>
      `);
    }

    if (parts.length === 0) {
      feed.innerHTML = `
        <div class="empty-state">
          <p>当前筛选条件下没有匹配的记录。</p>
        </div>
      `;
      return;
    }

    const wasAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
    feed.innerHTML = parts.join('');

    if (state.autoScroll && (newlyAddedSteps.size > 0 || wasAtBottom)) {
      requestAnimationFrame(() => {
        feed.scrollTop = feed.scrollHeight;
      });
    }
  }

  function findStepByIndex(stepIdx) {
    if (!state.data?.turns) return null;
    for (const t of state.data.turns) {
      for (const s of t.steps || []) {
        if (s.stepIndex === stepIdx) return s;
      }
    }
    return null;
  }

  async function refreshConversations() {
    try {
      const res = await apiFetch('/api/conversations?limit=25');
      if (!res.ok) return;
      const payload = await res.json();
      if (Array.isArray(payload.conversations)) {
        state.conversations = payload.conversations;
        renderConversationsSelect();
      }
    } catch {}
  }

  async function poll(force = false) {
    if (state.paused && !force) return;

    state.convTick += 1;
    if (force || state.convTick % 8 === 1) {
      refreshConversations();
    }

    const convId = activeConvId();
    const qs = new URLSearchParams();
    if (convId) qs.set('conversationId', convId);
    if (!force && state.etag && convId === state.initializedConvId) {
      qs.set('etag', state.etag);
    }

    try {
      const res = await apiFetch(`/api/transcript?${qs.toString()}`);
      if (!res.ok) return;
      const payload = await res.json();
      if (payload.unchanged) return;

      const switchedConv = payload.conversationId !== state.initializedConvId;
      const newlyAdded = new Set();

      if (switchedConv) {
        state.initializedConvId = payload.conversationId || '';
        state.seenSteps.clear();
        state.expandedSteps.clear();
        const thinkingIndices = [];
        for (const t of payload.turns || []) {
          for (const s of t.steps || []) {
            state.seenSteps.add(s.stepIndex);
            if (s.thinking) thinkingIndices.push(s.stepIndex);
          }
        }
        for (const idx of thinkingIndices.slice(-3)) {
          state.expandedSteps.add(idx);
        }
      } else {
        for (const t of payload.turns || []) {
          for (const s of t.steps || []) {
            if (!state.seenSteps.has(s.stepIndex)) {
              state.seenSteps.add(s.stepIndex);
              newlyAdded.add(s.stepIndex);
              if (s.thinking || s.isError) {
                state.expandedSteps.add(s.stepIndex);
              }
            }
          }
        }
      }

      state.etag = payload.etag || '';
      state.data = payload;
      render(payload, newlyAdded);
    } catch {}
  }

  function schedule() {
    clearTimeout(state.timer);
    const delay = document.hidden ? 4000 : POLL_MS;
    state.timer = setTimeout(async () => {
      await poll(false);
      schedule();
    }, delay);
  }

  // ---------- Events ----------
  $('btn-pause').addEventListener('click', () => {
    state.paused = !state.paused;
    $('btn-pause').textContent = state.paused ? '恢复' : '暂停';
    $('btn-pause').classList.toggle('active', state.paused);
    $('live-dot').classList.toggle('paused', state.paused);
    $('live-status').classList.toggle('paused', state.paused);
    $('live-status').textContent = state.paused ? 'PAUSED' : 'LIVE';
    if (!state.paused) poll(true);
  });

  $('btn-autoscroll').addEventListener('click', () => {
    state.autoScroll = !state.autoScroll;
    $('btn-autoscroll').classList.toggle('active', state.autoScroll);
  });

  $('btn-refresh').addEventListener('click', () => poll(true));

  $('conv-select').addEventListener('change', (e) => {
    state.selectedConvId = e.target.value;
    state.etag = '';
    poll(true);
  });

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      if (state.data) render(state.data);
    });
  });

  $('search-input').addEventListener('input', (e) => {
    state.query = e.target.value;
    if (state.data) render(state.data);
  });

  $('btn-expand-all').addEventListener('click', () => {
    if (!state.data?.turns) return;
    for (const t of state.data.turns) {
      for (const s of t.steps || []) state.expandedSteps.add(s.stepIndex);
    }
    render(state.data);
  });

  $('btn-collapse-all').addEventListener('click', () => {
    state.expandedSteps.clear();
    if (state.data) render(state.data);
  });

  $('feed').addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy-step]');
    if (copyBtn) {
      e.stopPropagation();
      const step = findStepByIndex(Number(copyBtn.dataset.copyStep));
      if (step?.thinking) {
        try {
          await navigator.clipboard.writeText(step.thinking);
          copyBtn.textContent = '已复制';
          setTimeout(() => {
            copyBtn.textContent = '复制';
          }, 1200);
        } catch {}
      }
      return;
    }

    const toolHead = e.target.closest('[data-toggle-tool]');
    if (toolHead) {
      toolHead.closest('.tool-pill')?.classList.toggle('open');
      return;
    }

    const head = e.target.closest('[data-toggle-step]');
    if (head) {
      const idx = Number(head.dataset.toggleStep);
      if (state.expandedSteps.has(idx)) state.expandedSteps.delete(idx);
      else state.expandedSteps.add(idx);
      head.closest('.step-card')?.classList.toggle('expanded', state.expandedSteps.has(idx));
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.paused) poll(false);
    schedule();
  });

  // Boot
  (async () => {
    await refreshConversations();
    await poll(true);
    schedule();
  })();
})();
