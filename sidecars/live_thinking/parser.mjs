import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeProtoFields(bytes) {
  const result = new Map();
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return result;
  let offset = 0;
  const readVarint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw new Error('Truncated');
      const b = bytes[offset++];
      value |= BigInt(b & 127) << shift;
      if (b < 128) return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
    }
    throw new Error('Malformed');
  };
  try {
    while (offset < bytes.length) {
      const tag = readVarint();
      if (typeof tag !== 'number') break;
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (field === 0) break;
      if (wire === 0) {
        const v = readVarint();
        if (!result.has(field)) result.set(field, []);
        result.get(field).push(v);
      } else if (wire === 2) {
        const len = readVarint();
        if (typeof len !== 'number' || len < 0 || offset + len > bytes.length) break;
        if (!result.has(field)) result.set(field, []);
        result.get(field).push(bytes.subarray(offset, offset + len));
        offset += len;
      } else if (wire === 1) {
        offset += 8;
      } else if (wire === 5) {
        offset += 4;
      } else {
        break;
      }
    }
  } catch {}
  return result;
}

function readAgyMaxTokenLimit(appDir, conversationId) {
  if (!appDir || !conversationId) return 0;
  const dbPath = path.join(appDir, 'conversations', `${conversationId}.db`);
  if (!fs.existsSync(dbPath)) return 0;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'executor_metadata'")
      .get();
    if (!hasTable) return 0;
    const row = db.prepare('SELECT data FROM executor_metadata ORDER BY rowid DESC LIMIT 1').get();
    if (row?.data instanceof Uint8Array) {
      const root = decodeProtoFields(row.data);
      const ccBytes = root.get(10)?.[0];
      if (ccBytes instanceof Uint8Array) {
        const cc = decodeProtoFields(ccBytes);
        const cpBytes = cc.get(2)?.[0];
        if (cpBytes instanceof Uint8Array) {
          const cp = decodeProtoFields(cpBytes);
          const lim = cp.get(5)?.[0];
          if (typeof lim === 'number' && lim > 0) return lim;
        }
      }
    }
  } catch {} finally {
    try { db?.close(); } catch {}
  }
  return 0;
}

function resolveContextLimit(appDir, conversationId, rawModel) {
  const agyLim = readAgyMaxTokenLimit(appDir, conversationId);
  if (agyLim > 0) return agyLim;
  const m = String(rawModel || '').toLowerCase();
  let modelMax = 1048576;
  if (/^gpt-oss-120b/.test(m)) modelMax = 131072;
  else if (/^claude-(?:sonnet|opus|haiku)-4-5(?:$|-)/.test(m) || /^claude-(?:sonnet|opus)-4(?:$|-2)/.test(m)) modelMax = 200000;
  else if (/^gemini-3\.1-flash-image/.test(m)) modelMax = 131072;
  else if (/^gemini-3-pro-image/.test(m)) modelMax = 65536;
  else if (/^gemini-2\.5-flash-image/.test(m)) modelMax = 32768;
  return m.includes('orchestrator') ? 512000 : Math.min(modelMax, 256000);
}

function getAppDataCandidates() {
  const dirs = [];
  if (process.env.ANTIGRAVITY_APP_DATA_DIR?.trim()) {
    dirs.push(path.resolve(process.env.ANTIGRAVITY_APP_DATA_DIR.trim()));
  }
  const geminiRoot = path.join(os.homedir(), '.gemini');
  for (const name of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    const candidate = path.join(geminiRoot, name);
    if (!dirs.includes(candidate)) dirs.push(candidate);
  }
  return dirs.filter((d) => fs.existsSync(path.join(d, 'brain')));
}

export function resolveTranscriptFile(conversationId) {
  if (!conversationId || !ID_RE.test(conversationId)) return null;
  for (const appDir of getAppDataCandidates()) {
    const logDir = path.join(appDir, 'brain', conversationId, '.system_generated', 'logs');
    const fullPath = path.join(logDir, 'transcript_full.jsonl');
    if (fs.existsSync(fullPath)) return { path: fullPath, isFull: true, appDir };
    const compactPath = path.join(logDir, 'transcript.jsonl');
    if (fs.existsSync(compactPath)) return { path: compactPath, isFull: false, appDir };
  }
  return null;
}

function cleanUserText(raw) {
  if (typeof raw !== 'string') return '';
  const m = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const text = m ? m[1] : raw;
  return text.replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '').trim();
}

function readFirstUserTitle(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(16384);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString('utf8', 0, bytesRead);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
            const cleaned = cleanUserText(obj.content).replace(/\s+/g, ' ');
            if (cleaned) return cleaned.slice(0, 80);
          }
        } catch {
          // ignore partial trailing line in 16KB prefix
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return '';
}

export function listRecentConversations(limit = 20) {
  const seen = new Map();
  for (const appDir of getAppDataCandidates()) {
    const brainDir = path.join(appDir, 'brain');
    let entries = [];
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      const logDir = path.join(brainDir, entry.name, '.system_generated', 'logs');
      const fullPath = path.join(logDir, 'transcript_full.jsonl');
      const compactPath = path.join(logDir, 'transcript.jsonl');
      const target = fs.existsSync(fullPath) ? fullPath : (fs.existsSync(compactPath) ? compactPath : null);
      if (!target) continue;
      try {
        const st = fs.statSync(target);
        const prev = seen.get(entry.name);
        if (!prev || st.mtimeMs > prev.mtimeMs) {
          seen.set(entry.name, {
            id: entry.name,
            mtimeMs: st.mtimeMs,
            mtime: st.mtime.toISOString(),
            size: st.size,
            filePath: target,
          });
        }
      } catch {}
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      title: readFirstUserTitle(item.filePath) || item.id.slice(0, 8),
      mtime: item.mtime,
      mtimeMs: item.mtimeMs,
      size: item.size,
    }));
}

function summarizeArg(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of ['toolSummary', 'focus', 'CommandLine', 'Path', 'query', 'queries', 'Description', 'Role']) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== '') {
      const val = Array.isArray(args[key]) ? args[key].join(', ') : String(args[key]);
      return val.replace(/\s+/g, ' ').slice(0, 140);
    }
  }
  try {
    return JSON.stringify(args).slice(0, 140);
  } catch {
    return '';
  }
}

function formatArgsPreview(args) {
  if (!args || typeof args !== 'object') return '';
  try {
    const raw = JSON.stringify(args, null, 2);
    return raw.length > 2500 ? `${raw.slice(0, 2500)}\n... [truncated ${raw.length - 2500} chars]` : raw;
  } catch {
    return String(args);
  }
}

export function getTranscriptMeta(conversationId) {
  const resolved = resolveTranscriptFile(conversationId);
  if (!resolved) return null;
  try {
    const st = fs.statSync(resolved.path);
    return {
      ...resolved,
      mtimeMs: st.mtimeMs,
      mtime: st.mtime.toISOString(),
      size: st.size,
      etag: `${conversationId}|${resolved.isFull ? 'F' : 'C'}|${Math.floor(st.mtimeMs)}|${st.size}`,
    };
  } catch {
    return null;
  }
}

export function parseConversationTranscript(conversationId) {
  const meta = getTranscriptMeta(conversationId);
  if (!meta) {
    return { found: false, conversationId: conversationId || null };
  }

  const raw = fs.readFileSync(meta.path, 'utf8');
  const lines = raw.split(/\r?\n/);

  const turns = [];
  let currentTurn = null;

  let totalThinkingSteps = 0;
  let totalThinkingChars = 0;
  let totalToolCalls = 0;
  let totalErrors = 0;
  let latestModel = '';
  let latestInputTokens = 0;
  let latestCacheReadTokens = 0;
  let latestOutputTokens = 0;
  let trailingChars = 0;
  let totalOutputTokens = 0;
  let firstPlannerBaseline = 0;
  let preFirstPlannerChars = 0;
  let pendingCheckpointStep = null;
  let contextEstimated = false;
  let parsedSteps = 0;
  let prevTsMs = null;
  let lastRawStep = null;

  const ensureTurn = (step) => {
    if (!currentTurn) {
      currentTurn = {
        turnIndex: turns.length + 1,
        userPrompt: '',
        startedAt: step.created_at || null,
        steps: [],
      };
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      // Skip incomplete trailing line if file is mid-write
      continue;
    }

    parsedSteps += 1;
    lastRawStep = obj;
    const tsMs = obj.created_at ? Date.parse(obj.created_at) : NaN;
    const deltaMs = !Number.isNaN(tsMs) && prevTsMs !== null && tsMs >= prevTsMs ? tsMs - prevTsMs : null;
    if (!Number.isNaN(tsMs)) prevTsMs = tsMs;

    if (obj.type === 'USER_INPUT' || obj.source === 'USER_EXPLICIT') {
      const cleanedPrompt = cleanUserText(obj.content);
      trailingChars += cleanedPrompt.length;
      if (firstPlannerBaseline === 0) preFirstPlannerChars += cleanedPrompt.length;
      currentTurn = {
        turnIndex: turns.length + 1,
        userPrompt: cleanedPrompt,
        startedAt: obj.created_at || null,
        stepIndex: obj.step_index ?? parsedSteps,
        steps: [],
      };
      turns.push(currentTurn);
      continue;
    }

    const turn = ensureTurn(obj);
    const isError = obj.status === 'ERROR' || Boolean(obj.error);
    if (isError) totalErrors += 1;

    if (obj.type === 'CHECKPOINT') {
      const text = typeof obj.content === 'string' ? obj.content.trim() : '';
      const cpPrompt = (Number(obj.input_tokens) || 0) + (Number(obj.cache_read_tokens) || 0);
      const beforeTokens =
        cpPrompt > 0 ? cpPrompt : latestInputTokens + latestOutputTokens + Math.ceil(trailingChars / 4);
      const summaryTokens =
        (Number(obj.output_tokens) || 0) > 0 ? Number(obj.output_tokens) : Math.ceil(text.length / 4);
      const baseline = firstPlannerBaseline > 0 ? firstPlannerBaseline : 15000;
      const estAfter = baseline + summaryTokens;

      latestInputTokens = estAfter;
      latestCacheReadTokens = 0;
      latestOutputTokens = 0;
      trailingChars = 0;
      contextEstimated = true;

      const cpStep = {
        kind: 'checkpoint',
        stepIndex: obj.step_index ?? parsedSteps,
        type: 'CHECKPOINT',
        createdAt: obj.created_at || null,
        deltaMs,
        status: obj.status || 'DONE',
        isError,
        beforeTokens,
        afterTokens: estAfter,
        isEstimatedAfter: true,
        summaryTokens,
        savedTokens: Math.max(0, beforeTokens - estAfter),
        content: text.length > 3000 ? `${text.slice(0, 3000)}\n... [truncated ${text.length - 3000} chars]` : text,
      };
      turn.steps.push(cpStep);
      pendingCheckpointStep = cpStep;
    } else if (obj.type === 'PLANNER_RESPONSE') {
      if (obj.model) latestModel = obj.model;
      const uncachedTok = Number(obj.input_tokens) || 0;
      const cacheTok = Number(obj.cache_read_tokens) || 0;
      const promptTok = uncachedTok + cacheTok;
      const outputTok = Number(obj.output_tokens) || 0;
      if (promptTok > 0) {
        if (firstPlannerBaseline === 0) {
          firstPlannerBaseline = Math.max(0, promptTok - Math.ceil(preFirstPlannerChars / 4));
        }
        if (pendingCheckpointStep) {
          pendingCheckpointStep.afterTokens = promptTok;
          pendingCheckpointStep.isEstimatedAfter = false;
          pendingCheckpointStep.savedTokens = Math.max(0, pendingCheckpointStep.beforeTokens - promptTok);
          pendingCheckpointStep = null;
        }
        latestInputTokens = promptTok;
        latestCacheReadTokens = cacheTok;
        latestOutputTokens = outputTok;
        trailingChars = 0;
        contextEstimated = false;
      }
      totalOutputTokens += outputTok;

      const thinking = typeof obj.thinking === 'string' ? obj.thinking.trim() : '';
      const content = typeof obj.content === 'string' ? obj.content.trim() : '';
      const rawCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
      const toolCalls = rawCalls.map((tc) => ({
        name: tc?.name || tc?.function?.name || 'tool',
        summary: summarizeArg(tc?.args || tc?.arguments),
        argsPreview: formatArgsPreview(tc?.args || tc?.arguments),
      }));

      if (thinking) {
        totalThinkingSteps += 1;
        totalThinkingChars += thinking.length;
      }
      totalToolCalls += toolCalls.length;

      if (thinking || content || toolCalls.length > 0 || isError) {
        turn.steps.push({
          kind: 'planner',
          stepIndex: obj.step_index ?? parsedSteps,
          createdAt: obj.created_at || null,
          deltaMs,
          status: obj.status || 'DONE',
          isError,
          model: obj.model || latestModel || '',
          thinking,
          content: content.length > 3000 ? `${content.slice(0, 3000)}\n... [truncated]` : content,
          toolCalls,
          tokens: {
            input: promptTok,
            cacheRead: cacheTok,
            output: outputTok,
          },
        });
      }
    } else if (obj.type === 'SYSTEM_MESSAGE') {
      const text = typeof obj.content === 'string' ? obj.content.trim() : '';
      if (text) {
        turn.steps.push({
          kind: 'system',
          stepIndex: obj.step_index ?? parsedSteps,
          createdAt: obj.created_at || null,
          deltaMs,
          status: obj.status || 'DONE',
          isError,
          content: text.length > 1200 ? `${text.slice(0, 1200)}\n... [truncated]` : text,
        });
      }
    } else {
      // Tool execution / GENERIC output
      const text = typeof obj.content === 'string' ? obj.content.trim() : '';
      trailingChars += text.length;
      const preview = text.length > 1500 ? `${text.slice(0, 1500)}\n... [truncated ${text.length - 1500} chars]` : text;
      turn.steps.push({
        kind: 'tool_result',
        stepIndex: obj.step_index ?? parsedSteps,
        type: obj.type || 'GENERIC',
        createdAt: obj.created_at || null,
        deltaMs,
        status: obj.status || 'DONE',
        isError,
        content: preview,
        error: obj.error ? String(obj.error).slice(0, 1000) : '',
      });
    }
  }

  const cacheHitRatio =
    latestInputTokens > 0 ? Math.round((latestCacheReadTokens / latestInputTokens) * 100) : 0;
  const contextLimit = resolveContextLimit(meta.appDir, conversationId, latestModel);
  const contextUsedTokens = latestInputTokens + latestOutputTokens + Math.ceil(trailingChars / 4);
  const contextUsedPercent =
    contextLimit > 0 ? Math.min(100, Math.round((contextUsedTokens / contextLimit) * 1000) / 10) : 0;

  // Detect live in-flight state from the latest raw step
  let activity = { isWorking: false, phase: 'idle', label: '', sinceIso: null };
  if (lastRawStep) {
    const lastTs = lastRawStep.created_at ? Date.parse(lastRawStep.created_at) : NaN;
    const ageMs = Number.isNaN(lastTs) ? 0 : Math.max(0, Date.now() - lastTs);
    const isFresh = ageMs < 10 * 60 * 1000; // ignore stale interrupted sessions > 10m old
    if (isFresh) {
      if (lastRawStep.type === 'USER_INPUT' || lastRawStep.source === 'USER_EXPLICIT') {
        const cleanedLast = cleanUserText(lastRawStep.content);
        if (/^\/compact(?:\s|$)/i.test(cleanedLast)) {
          activity = {
            isWorking: true,
            phase: 'compacting',
            label: '正在压缩上下文中...',
            sinceIso: lastRawStep.created_at || meta.mtime,
          };
        } else {
          activity = {
            isWorking: true,
            phase: 'thinking',
            label: '正在思考中...',
            sinceIso: lastRawStep.created_at || meta.mtime,
          };
        }
      } else if (lastRawStep.type === 'CHECKPOINT') {
        if (lastRawStep.status && lastRawStep.status !== 'DONE' && lastRawStep.status !== 'ERROR') {
          activity = {
            isWorking: true,
            phase: 'compacting',
            label: '正在压缩上下文中...',
            sinceIso: lastRawStep.created_at || meta.mtime,
          };
        }
      } else if (lastRawStep.type === 'PLANNER_RESPONSE') {
        const calls = Array.isArray(lastRawStep.tool_calls) ? lastRawStep.tool_calls : [];
        if (calls.length > 0) {
          const names = calls.map((c) => c?.name || c?.function?.name || 'tool').slice(0, 3).join(', ');
          activity = {
            isWorking: true,
            phase: 'tooling',
            label: `正在执行工具: ${names}`,
            sinceIso: lastRawStep.created_at || meta.mtime,
          };
        } else if (lastRawStep.status && lastRawStep.status !== 'DONE' && lastRawStep.status !== 'ERROR') {
          activity = {
            isWorking: true,
            phase: 'thinking',
            label: '正在生成思考与回复...',
            sinceIso: lastRawStep.created_at || meta.mtime,
          };
        }
      } else if (lastRawStep.type === 'GENERIC' || lastRawStep.type === 'SYSTEM_MESSAGE') {
        activity = {
          isWorking: true,
          phase: 'thinking',
          label: '正在分析结果并思考下一步...',
          sinceIso: lastRawStep.created_at || meta.mtime,
        };
      }
    }
  }

  return {
    found: true,
    conversationId,
    isFullTranscript: meta.isFull,
    etag: meta.etag,
    updatedAt: meta.mtime,
    activity,
    stats: {
      turns: turns.length,
      totalSteps: parsedSteps,
      thinkingSteps: totalThinkingSteps,
      thinkingChars: totalThinkingChars,
      toolCalls: totalToolCalls,
      errors: totalErrors,
      latestModel,
      latestInputTokens,
      latestCacheReadTokens,
      cacheHitRatio,
      totalOutputTokens,
      contextUsedTokens,
      contextLimit,
      contextUsedPercent,
      contextEstimated,
    },
    turns,
  };
}
