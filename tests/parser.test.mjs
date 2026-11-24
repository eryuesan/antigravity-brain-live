import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-live-test-'));
process.env.ANTIGRAVITY_APP_DATA_DIR = tmpRoot;

const {
  listRecentConversations,
  parseConversationTranscript,
  getTranscriptMeta,
} = await import('../sidecars/live_thinking/parser.mjs');

test('parses transcript turns, thinking blocks, tool calls, and cache ratio accurately', () => {
  const convId = '11111111-2222-3333-4444-555555555555';
  const logDir = path.join(tmpRoot, 'brain', convId, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const lines = [
    JSON.stringify({
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-24T01:00:00Z',
      content: '<USER_REQUEST>\nInspect the bug in parser.mjs\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>',
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T01:00:03Z',
      model: 'gemini-4-neon-high',
      input_tokens: 2000,
      cache_read_tokens: 18000,
      output_tokens: 500,
      thinking: 'Checking `parser.mjs` to locate the root cause.',
      tool_calls: [
        { name: 'read_file', args: { Path: 'parser.mjs' } },
      ],
    }),
    JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-24T01:00:04Z',
      content: 'file contents here',
    }),
  ];

  fs.writeFileSync(path.join(logDir, 'transcript_full.jsonl'), `${lines.join('\n')}\n`, 'utf8');

  const convs = listRecentConversations(20);
  const found = convs.find((c) => c.id === convId);
  assert.ok(found, 'synthetic conversation should be discovered');
  assert.equal(found.title, 'Inspect the bug in parser.mjs');

  const meta = getTranscriptMeta(convId);
  assert.ok(meta?.etag);

  const parsed = parseConversationTranscript(convId);
  assert.equal(parsed.found, true);
  assert.equal(parsed.isFullTranscript, true);
  assert.equal(parsed.etag, meta.etag);
  assert.equal(parsed.stats.turns, 1);
  assert.equal(parsed.stats.thinkingSteps, 1);
  assert.equal(parsed.stats.toolCalls, 1);
  assert.equal(parsed.stats.latestInputTokens, 20000);
  assert.equal(parsed.stats.cacheHitRatio, 90);
  assert.equal(parsed.stats.contextLimit, 256000);
  assert.ok(parsed.stats.contextUsedTokens >= 20500);
  assert.equal(parsed.turns[0].userPrompt, 'Inspect the bug in parser.mjs');
});

test('detects live /compact activity and resets context meter on CHECKPOINT', () => {
  const convId = '22222222-3333-4444-5555-666666666666';
  const logDir = path.join(tmpRoot, 'brain', convId, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'transcript_full.jsonl');
  const nowIso = new Date().toISOString();

  const preCompact = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: nowIso,
      content: '<USER_REQUEST>\nStart session\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      model: 'gemini-4-neon-high',
      input_tokens: 16000,
      cache_read_tokens: 0,
      output_tokens: 400,
      thinking: 'Initial planning.',
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      model: 'gemini-4-neon-high',
      input_tokens: 4000,
      cache_read_tokens: 196000,
      output_tokens: 500,
      thinking: 'Heavy session context.',
    },
    {
      step_index: 3,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: nowIso,
      content: '<USER_REQUEST>\n/compact \n</USER_REQUEST>',
    },
  ];

  fs.writeFileSync(file, `${preCompact.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');

  const midCompact = parseConversationTranscript(convId);
  assert.equal(midCompact.activity.isWorking, true);
  assert.equal(midCompact.activity.phase, 'compacting');
  assert.equal(midCompact.turns.at(-1).userPrompt, '/compact');

  const withCheckpoint = [
    ...preCompact,
    {
      step_index: 4,
      source: 'SYSTEM',
      type: 'CHECKPOINT',
      status: 'DONE',
      created_at: nowIso,
      input_tokens: 3000,
      cache_read_tokens: 197000,
      output_tokens: 5000,
      content: '# Resuming from a compaction\nSummary contents.',
    },
  ];
  fs.writeFileSync(file, `${withCheckpoint.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');

  const postCompact = parseConversationTranscript(convId);
  assert.equal(postCompact.activity.isWorking, false);
  assert.equal(postCompact.stats.contextEstimated, true);
  assert.equal(postCompact.stats.cacheHitRatio, 0);
  assert.ok(postCompact.stats.contextUsedTokens < 30000, 'context meter should immediately drop after CHECKPOINT');
  const cpStep = postCompact.turns.at(-1).steps[0];
  assert.equal(cpStep.kind, 'checkpoint');
  assert.equal(cpStep.beforeTokens, 200000);
  assert.equal(cpStep.isEstimatedAfter, true);
  assert.ok(cpStep.savedTokens > 170000);

  const afterNextPlanner = [
    ...withCheckpoint,
    {
      step_index: 5,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: nowIso,
      content: '<USER_REQUEST>\nContinue\n</USER_REQUEST>',
    },
    {
      step_index: 6,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      model: 'gemini-4-neon-high',
      input_tokens: 23500,
      cache_read_tokens: 0,
      output_tokens: 300,
      thinking: 'Resumed after compaction.',
    },
  ];
  fs.writeFileSync(file, `${afterNextPlanner.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');

  const confirmed = parseConversationTranscript(convId);
  assert.equal(confirmed.stats.contextEstimated, false);
  assert.equal(confirmed.stats.latestInputTokens, 23500);
  const confirmedCp = confirmed.turns[1].steps[0];
  assert.equal(confirmedCp.afterTokens, 23500);
  assert.equal(confirmedCp.isEstimatedAfter, false);
  assert.equal(confirmedCp.savedTokens, 176500);
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
