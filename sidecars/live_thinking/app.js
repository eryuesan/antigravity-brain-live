(() => {
  const POLL_MS = 300;
  const TARGET_TPS = 150;
  const BASE_TOKEN_MS = 1000 / TARGET_TPS;
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
    typewriter: true,
    expandedSteps: new Set(),
    seenSteps: new Set(),
    typingMap: new Map(), // stepIndex -> { fullText, tokens, idx, nextDue, baseDelay, finishAt }
    typingRaf: null,
    workingTimer: null,
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

  // Split text into natural words / 1-2 CJK char clusters / punctuation / newlines
  function tokenizeForStream(text) {
    const clean = String(text || '').trim();
    const re = /\r?\n+|[A-Za-z0-9_./:'"-]+[ \t]*|[\u4e00-\u9fff]{1,2}|[，。！？；：,.!?;:][ \t]*|[^\s\u4e00-\u9fffA-Za-z0-9]+|[ \t]+/g;
    return clean.match(re) || [];
  }

  function tokenDelayMs(tok, baseDelay) {
    let delay = baseDelay;
    if (/^\r?\n/.test(tok)) {
      delay += 38;
    } else if (/[。！？.!?]\s*$/.test(tok)) {
      delay += 30;
    } else if (/[，；：,;:]\s*$/.test(tok)) {
      delay += 14;
    }
    // Slight organic jitter (±14%) while keeping ~150 TPS average cadence
    const jitter = 0.86 + Math.random() * 0.28;
    return Math.max(3, delay * jitter);
  }

  function buildInitialStreamHtml(item) {
    const settled = item.tokens.slice(0, item.idx).join('');
    const paras = settled.split(/\r?\n+/);
    const pHtml = paras
      .map((p, i) => {
        const isLast = i === paras.length - 1;
        return `<p><span class="stream-settled">${esc(p)}</span>${isLast ? '<span class="stream-orb"></span>' : ''}</p>`;
      })
      .join('');
    return `<div class="stream-live">${pHtml || '<p><span class="stream-orb"></span></p>'}</div>`;
  }

  function appendStreamTokenToDom(thinkingEl, tok) {
    let liveBox = thinkingEl.querySelector('.stream-live');
    if (!liveBox) {
      thinkingEl.innerHTML = '<div class="stream-live"><p><span class="stream-orb"></span></p></div>';
      liveBox = thinkingEl.querySelector('.stream-live');
    }
    let orb = liveBox.querySelector('.stream-orb');
    if (!orb) {
      orb = document.createElement('span');
      orb.className = 'stream-orb';
    }

    if (/^\r?\n/.test(tok)) {
      const nextP = document.createElement('p');
      nextP.appendChild(orb);
      liveBox.appendChild(nextP);
      return;
    }

    let currentP = liveBox.lastElementChild;
    if (!currentP || currentP.tagName !== 'P') {
      currentP = document.createElement('p');
      liveBox.appendChild(currentP);
    }

    const span = document.createElement('span');
    span.className = 'stream-chunk';
    span.textContent = tok;
    if (orb.parentNode === currentP) {
      currentP.insertBefore(span, orb);
    } else {
      currentP.appendChild(span);
      currentP.appendChild(orb);
    }
  }

  function appendInlineTokenToDom(targetEl, tok) {
    let orb = targetEl.querySelector('.stream-orb');
    if (!orb) {
      orb = document.createElement('span');
      orb.className = 'stream-orb is-mini';
      targetEl.appendChild(orb);
    }
    const span = document.createElement('span');
    span.className = 'stream-chunk';
    span.textContent = tok;
    targetEl.insertBefore(span, orb);
  }

  function createStreamEntry(step, now) {
    const hasThinking = Boolean(step.thinking);
    const rawTools = Array.isArray(step.toolCalls) ? step.toolCalls : [];
    const tokens = hasThinking ? tokenizeForStream(step.thinking) : [];
    const baseDelay = BASE_TOKEN_MS;
    const tools = rawTools.map((tc) => {
      const summary = String(tc.summary || '').trim();
      const sTokens = summary ? tokenizeForStream(summary) : [];
      return {
        summary,
        tokens: sTokens,
        idx: 0,
        baseDelay: BASE_TOKEN_MS,
      };
    });
    return {
      stage: hasThinking ? 'thinking' : 'tools',
      fullText: step.thinking || '',
      tokens,
      idx: 0,
      baseDelay,
      tools,
      toolIdx: 0,
      toolStarted: false,
      nextDue: now,
      settleUntil: 0,
    };
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
    if (step.kind === 'checkpoint') {
      return state.filter !== 'errors' || Boolean(step.isError);
    }
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
    if (step.kind === 'checkpoint' && ('compact 压缩 上下文 checkpoint'.includes(lower))) return true;
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

  // ---------- Organic Sequential Stream Engine ----------
  function revealPendingWorkingCard(feed) {
    if (state.typingMap.size > 0) return;
    const wc = feed.querySelector('.live-working-card.is-stream-hidden');
    if (wc) {
      wc.classList.remove('is-stream-hidden');
      wc.classList.add('is-stream-reveal');
    }
  }

  function finalizeCardDom(cardEl, item, q) {
    if (!cardEl) return;
    cardEl.classList.remove('is-stream-hidden');
    const thinkingEl = cardEl.querySelector('.thinking-text');
    if (thinkingEl && item.fullText) {
      thinkingEl.innerHTML = renderRichText(item.fullText, q);
      thinkingEl.classList.remove('is-typing');
      thinkingEl.removeAttribute('title');
      thinkingEl.removeAttribute('data-finish-typing');
    }
    const pillsBox = cardEl.querySelector('.tool-pills');
    if (pillsBox) pillsBox.classList.remove('is-stream-hidden');
    item.tools.forEach((t, i) => {
      const pill = cardEl.querySelector(`[data-tool-idx="${i}"]`);
      if (!pill) return;
      pill.classList.remove('is-stream-hidden');
      const sumEl = pill.querySelector('.tool-summary');
      if (sumEl) {
        sumEl.textContent = t.summary;
        sumEl.classList.remove('is-typing');
        sumEl.removeAttribute('title');
        sumEl.removeAttribute('data-finish-typing');
      }
    });
    const metaEl = cardEl.querySelector('.token-meta');
    if (metaEl) {
      metaEl.classList.remove('is-stream-hidden');
      metaEl.classList.add('is-stream-reveal');
    }
  }

  function ensureTypewriterLoop() {
    if (state.typingRaf !== null || state.typingMap.size === 0) return;

    const tick = (now) => {
      state.typingRaf = null;
      if (state.typingMap.size === 0) return;

      const feed = $('feed');
      const q = state.query.trim();
      let progressed = false;

      // Stream strictly one step at a time in chronological order
      for (const [stepIdx, item] of Array.from(state.typingMap.entries())) {
        const cardEl = feed.querySelector(`[data-step="${stepIdx}"]`);
        if (!cardEl) {
          state.typingMap.delete(stepIdx);
          continue;
        }

        const completeStep = () => {
          const metaEl = cardEl.querySelector('.token-meta');
          if (metaEl) {
            metaEl.classList.remove('is-stream-hidden');
            metaEl.classList.add('is-stream-reveal');
          }
          state.typingMap.delete(stepIdx);
          const nextEntry = state.typingMap.entries().next().value;
          if (nextEntry) {
            const [nextIdx, nextItem] = nextEntry;
            nextItem.nextDue = now;
            const nextCard = feed.querySelector(`[data-step="${nextIdx}"]`);
            if (nextCard) {
              nextCard.classList.remove('is-stream-hidden');
              nextCard.classList.add('is-pill-reveal');
            }
          } else {
            revealPendingWorkingCard(feed);
          }
          progressed = true;
        };

        if (cardEl.classList.contains('is-stream-hidden')) {
          cardEl.classList.remove('is-stream-hidden');
          cardEl.classList.add('is-pill-reveal');
          item.nextDue = now;
          progressed = true;
        }

        if (item.stage === 'thinking') {
          if (now >= item.nextDue) {
            if (now - item.nextDue > 64) item.nextDue = now - 16;
            const thinkingEl = cardEl.querySelector('.thinking-text');
            let emitted = 0;
            while (item.idx < item.tokens.length && now >= item.nextDue && emitted < 16) {
              const tok = item.tokens[item.idx++];
              if (thinkingEl) {
                appendStreamTokenToDom(thinkingEl, tok);
                progressed = true;
              }
              item.nextDue += tokenDelayMs(tok, item.baseDelay);
              emitted += 1;
            }
            if (item.idx >= item.tokens.length) {
              const orb = thinkingEl?.querySelector('.stream-orb');
              if (orb) orb.remove();
              item.stage = 'thinking_settle';
              item.settleUntil = now + 170;
            }
          }
          break;
        }

        if (item.stage === 'thinking_settle') {
          if (now >= item.settleUntil) {
            const thinkingEl = cardEl.querySelector('.thinking-text');
            if (thinkingEl) {
              thinkingEl.innerHTML = renderRichText(item.fullText, q);
              thinkingEl.classList.remove('is-typing');
              thinkingEl.removeAttribute('title');
              thinkingEl.removeAttribute('data-finish-typing');
            }
            progressed = true;
            if (item.tools.length > 0) {
              item.stage = 'tools';
              item.toolIdx = 0;
              item.toolStarted = false;
              item.nextDue = now + 55;
            } else {
              completeStep();
            }
          }
          break;
        }

        if (item.stage === 'tools') {
          if (now >= item.nextDue) {
            const pillsBox = cardEl.querySelector('.tool-pills');
            if (pillsBox) pillsBox.classList.remove('is-stream-hidden');

            const toolState = item.tools[item.toolIdx];
            if (!toolState) {
              completeStep();
              break;
            }

            const pillEl = cardEl.querySelector(`[data-tool-idx="${item.toolIdx}"]`);
            if (!item.toolStarted) {
              item.toolStarted = true;
              if (pillEl) {
                pillEl.classList.remove('is-stream-hidden');
                pillEl.classList.add('is-pill-reveal');
                progressed = true;
              }
              if (toolState.tokens.length > 0) {
                const sumEl = pillEl?.querySelector('.tool-summary');
                if (sumEl) {
                  sumEl.classList.add('is-typing');
                  sumEl.setAttribute('data-finish-typing', String(stepIdx));
                  sumEl.setAttribute('title', '点击立即显示全文');
                  sumEl.innerHTML = '<span class="stream-orb is-mini"></span>';
                }
                item.nextDue = now + 45;
              } else {
                item.toolIdx += 1;
                item.toolStarted = false;
                item.nextDue = now + 55;
              }
            } else {
              if (now - item.nextDue > 64) item.nextDue = now - 16;
              const sumEl = pillEl?.querySelector('.tool-summary');
              let emitted = 0;
              while (toolState.idx < toolState.tokens.length && now >= item.nextDue && emitted < 16) {
                const tok = toolState.tokens[toolState.idx++];
                if (sumEl) {
                  appendInlineTokenToDom(sumEl, tok);
                  progressed = true;
                }
                item.nextDue += tokenDelayMs(tok, toolState.baseDelay);
                emitted += 1;
              }
              if (toolState.idx >= toolState.tokens.length) {
                const orb = sumEl?.querySelector('.stream-orb');
                if (orb) orb.remove();
                item.stage = 'tool_settle';
                item.settleUntil = now + 150;
              }
            }
          }
          break;
        }

        if (item.stage === 'tool_settle') {
          if (now >= item.settleUntil) {
            const toolState = item.tools[item.toolIdx];
            const pillEl = cardEl.querySelector(`[data-tool-idx="${item.toolIdx}"]`);
            const sumEl = pillEl?.querySelector('.tool-summary');
            if (sumEl && toolState) {
              sumEl.textContent = toolState.summary;
              sumEl.classList.remove('is-typing');
              sumEl.removeAttribute('title');
              sumEl.removeAttribute('data-finish-typing');
            }
            item.toolIdx += 1;
            item.toolStarted = false;
            if (item.toolIdx < item.tools.length) {
              item.stage = 'tools';
              item.nextDue = now + 45;
            } else {
              completeStep();
            }
            progressed = true;
          }
          break;
        }
      }

      if (progressed && state.autoScroll) {
        feed.scrollTop = feed.scrollHeight;
      }

      if (state.typingMap.size > 0) {
        state.typingRaf = requestAnimationFrame(tick);
      } else {
        revealPendingWorkingCard(feed);
      }
    };

    state.typingRaf = requestAnimationFrame(tick);
  }

  function flushAllTyping() {
    if (state.typingRaf !== null) {
      cancelAnimationFrame(state.typingRaf);
      state.typingRaf = null;
    }
    const feed = $('feed');
    const q = state.query.trim();
    for (const [stepIdx, item] of state.typingMap.entries()) {
      const cardEl = feed.querySelector(`[data-step="${stepIdx}"]`);
      finalizeCardDom(cardEl, item, q);
    }
    state.typingMap.clear();
    revealPendingWorkingCard(feed);
  }

  function finishTypingStep(stepIdx) {
    const item = state.typingMap.get(stepIdx);
    if (!item) return;
    state.typingMap.delete(stepIdx);
    const feed = $('feed');
    const cardEl = feed.querySelector(`[data-step="${stepIdx}"]`);
    finalizeCardDom(cardEl, item, state.query.trim());
    revealPendingWorkingCard(feed);
  }

  // ---------- Live Working Timer ----------
  function syncWorkingTimer() {
    clearInterval(state.workingTimer);
    const act = state.data?.activity;
    if (!act?.isWorking || !act.sinceIso) return;
    const baseMs = Date.parse(act.sinceIso);
    if (Number.isNaN(baseMs)) return;

    const update = () => {
      const el = $('live-working-timer');
      if (!el) return;
      const elapsedSec = Math.max(0, (Date.now() - baseMs) / 1000);
      el.textContent = `${elapsedSec.toFixed(1)}s`;
    };
    update();
    state.workingTimer = setInterval(update, 100);
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
      const approx = st.contextEstimated ? '~' : '';
      $('ctx-ratio').textContent = `${approx}${fmtTok(usedTok)} / ${fmtLimit(limTok)}`;
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
    const turns = data.turns || [];
    const showWorking = Boolean(data.activity?.isWorking) && state.filter !== 'errors' && !q;

    const activeStreamStepIdx = state.typingMap.size > 0 ? state.typingMap.keys().next().value : null;

    turns.forEach((turn, tIdx) => {
      const isLastTurn = tIdx === turns.length - 1;
      const visibleSteps = (turn.steps || []).filter((s) => matchesFilter(s) && matchesSearch(s, q));
      if (visibleSteps.length === 0 && !(isLastTurn && showWorking)) return;

      const stepHtml = visibleSteps
        .map((step) => {
          const isExpanded = state.expandedSteps.has(step.stepIndex);
          const isNew = newlyAddedSteps.has(step.stepIndex);
          const isQueuedHidden =
            state.typingMap.has(step.stepIndex) &&
            activeStreamStepIdx !== null &&
            step.stepIndex !== activeStreamStepIdx;
          const cardCls = [
            'step-card',
            step.thinking ? 'is-thinking' : '',
            step.kind === 'checkpoint' ? 'is-compact' : '',
            step.isError ? 'is-error' : '',
            isExpanded ? 'expanded' : '',
            isNew ? 'is-new' : '',
            isQueuedHidden ? 'is-stream-hidden' : '',
          ]
            .filter(Boolean)
            .join(' ');

          let tagCls = 'sys';
          let tagLabel = step.type || step.kind;
          if (step.isError) {
            tagCls = 'err';
            tagLabel = 'ERROR';
          } else if (step.kind === 'checkpoint') {
            tagCls = 'compact';
            tagLabel = `COMPACT #${step.stepIndex}`;
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

          let compactStripHtml = '';
          if (step.kind === 'checkpoint') {
            const before = Number(step.beforeTokens) || 0;
            const after = Number(step.afterTokens) || 0;
            const saved = Number(step.savedTokens) || 0;
            const dropPct = before > 0 ? Math.round((saved / before) * 100) : 0;
            const afterPrefix = step.isEstimatedAfter ? '~' : '';
            const metrics = [];
            if (before > 0) {
              metrics.push(`<span class="compact-flow">${fmtTok(before)} → ${afterPrefix}${fmtTok(after)}</span>`);
            }
            if (saved > 0) {
              metrics.push(`<span class="compact-saved">释放 ${fmtTok(saved)} (-${dropPct}%)</span>`);
            }
            if (step.summaryTokens > 0) {
              metrics.push(`<span class="compact-meta">摘要 ${fmtTok(step.summaryTokens)}</span>`);
            }
            compactStripHtml = `
              <div class="compact-strip" data-toggle-step="${step.stepIndex}" title="点击展开 / 收起压缩摘要">
                <span class="compact-title">上下文已压缩</span>
                <span class="compact-metrics">${metrics.join(' · ')}</span>
              </div>
            `;
          }

          const typingEntry = state.typingMap.get(step.stepIndex);
          const isThinkingStreaming =
            Boolean(typingEntry) && (typingEntry.stage === 'thinking' || typingEntry.stage === 'thinking_settle');
          const isToolsPending = isThinkingStreaming;

          let bodyHtml = '';
          if (step.thinking) {
            const inner = isThinkingStreaming
              ? buildInitialStreamHtml(typingEntry)
              : renderRichText(step.thinking, q);
            bodyHtml += `<div class="thinking-text${isThinkingStreaming ? ' is-typing' : ''}"${isThinkingStreaming ? ` data-finish-typing="${step.stepIndex}" title="点击立即显示全文"` : ''}>${inner}</div>`;
          }
          if (Array.isArray(step.toolCalls) && step.toolCalls.length > 0) {
            bodyHtml += `<div class="tool-pills${isToolsPending ? ' is-stream-hidden' : ''}">${step.toolCalls
              .map((tc, tcIdx) => {
                let pillHidden = false;
                let sumTyping = false;
                let sumInner = esc(tc.summary);
                if (typingEntry) {
                  if (isToolsPending) {
                    pillHidden = true;
                    sumInner = '';
                  } else if (tcIdx > typingEntry.toolIdx || (tcIdx === typingEntry.toolIdx && !typingEntry.toolStarted)) {
                    pillHidden = true;
                    sumInner = '';
                  } else if (tcIdx === typingEntry.toolIdx && typingEntry.toolStarted) {
                    const tState = typingEntry.tools[tcIdx];
                    const settled = tState ? tState.tokens.slice(0, tState.idx).join('') : '';
                    sumTyping = true;
                    const orbHtml = typingEntry.stage === 'tool_settle' ? '' : '<span class="stream-orb is-mini"></span>';
                    sumInner = `<span class="stream-settled">${esc(settled)}</span>${orbHtml}`;
                  }
                }
                return `
                  <div class="tool-pill${pillHidden ? ' is-stream-hidden' : ''}" data-tool-idx="${tcIdx}">
                    <div class="tool-pill-head" data-toggle-tool>
                      <span class="tool-name">${esc(tc.name)}</span>
                      <span class="tool-summary${sumTyping ? ' is-typing' : ''}"${sumTyping ? ` data-finish-typing="${step.stepIndex}" title="点击立即显示全文"` : ''}>${sumInner}</span>
                    </div>
                    <pre class="tool-args">${esc(tc.argsPreview)}</pre>
                  </div>
                `;
              })
              .join('')}</div>`;
          }
          if (step.content && step.kind !== 'planner') {
            bodyHtml += `<div class="raw-output">${esc(step.content)}</div>`;
          }
          if (step.error) {
            bodyHtml += `<div class="raw-output is-err-text">${esc(step.error)}</div>`;
          }
          if (step.tokens && (step.tokens.input > 0 || step.tokens.output > 0)) {
            bodyHtml += `<div class="token-meta${typingEntry ? ' is-stream-hidden' : ''}">in ${fmtTok(step.tokens.input)} · cache ${fmtTok(step.tokens.cacheRead)} · out ${fmtTok(step.tokens.output)}</div>`;
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
              ${compactStripHtml}
              <div class="step-body">${bodyHtml}</div>
            </article>
          `;
        })
        .join('');

      let workingHtml = '';
      if (isLastTurn && showWorking) {
        const phase = data.activity.phase || 'thinking';
        const isTooling = phase === 'tooling';
        const isCompacting = phase === 'compacting';
        const phaseCls = isCompacting ? ' is-compacting' : isTooling ? ' is-tooling' : '';
        const badgeCls = isCompacting ? 'compact' : isTooling ? 'tool' : 'think';
        const badgeText = isCompacting ? 'COMPACTING' : isTooling ? 'RUNNING' : 'THINKING';
        const defaultLabel = isCompacting ? '正在压缩上下文中...' : '正在思考中...';
        const hideUntilStreamDone = state.typingMap.size > 0;
        workingHtml = `
          <div class="live-working-card${phaseCls}${hideUntilStreamDone ? ' is-stream-hidden' : ''}">
            <div class="live-working-left">
              <span class="live-spinner"></span>
              <span class="step-tag ${badgeCls}">${badgeText}</span>
              <span class="live-working-text">${esc(data.activity.label || defaultLabel)}</span>
            </div>
            <span class="live-working-timer" id="live-working-timer">0.0s</span>
          </div>
        `;
      }

      parts.push(`
        <section class="turn-group">
          <div class="turn-header" title="${esc(turn.userPrompt || '')}">
            <span class="turn-num">Turn ${turn.turnIndex}</span>
            <div class="turn-prompt">${esc(turn.userPrompt || '(系统/继续执行)')}</div>
          </div>
          ${stepHtml}
          ${workingHtml}
        </section>
      `);
    });

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
    syncWorkingTimer();

    if (state.typingMap.size > 0) {
      ensureTypewriterLoop();
    }

    if (state.autoScroll && (newlyAddedSteps.size > 0 || showWorking || wasAtBottom)) {
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
    if (force || state.convTick % 20 === 1) {
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
        flushAllTyping();
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
        const now = performance.now();
        for (const t of payload.turns || []) {
          for (const s of t.steps || []) {
            if (!state.seenSteps.has(s.stepIndex)) {
              state.seenSteps.add(s.stepIndex);
              newlyAdded.add(s.stepIndex);
              if (s.thinking || s.isError || (s.kind === 'planner' && Array.isArray(s.toolCalls) && s.toolCalls.length > 0)) {
                state.expandedSteps.add(s.stepIndex);
              }
              const canStream =
                state.typewriter &&
                matchesFilter(s) &&
                (Boolean(s.thinking) || (s.kind === 'planner' && Array.isArray(s.toolCalls) && s.toolCalls.length > 0));
              if (canStream) {
                // Keep queued steps in strict order without prematurely skipping; only guard extreme idle backlog
                while (state.typingMap.size >= 20) {
                  const oldestKey = state.typingMap.keys().next().value;
                  if (oldestKey === undefined) break;
                  finishTypingStep(oldestKey);
                }
                state.typingMap.set(s.stepIndex, createStreamEntry(s, now));
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
    const delay = document.hidden ? 3000 : POLL_MS;
    state.timer = setTimeout(async () => {
      await poll(false);
      schedule();
    }, delay);
  }

  // ---------- Events ----------
  $('btn-typewriter').addEventListener('click', () => {
    state.typewriter = !state.typewriter;
    $('btn-typewriter').classList.toggle('active', state.typewriter);
    if (!state.typewriter) {
      flushAllTyping();
    }
  });

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
    const typingEl = e.target.closest('[data-finish-typing]');
    if (typingEl) {
      const idx = Number(typingEl.dataset.finishTyping);
      if (state.typingMap.has(idx)) {
        finishTypingStep(idx);
        return;
      }
    }

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
