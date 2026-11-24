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

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
