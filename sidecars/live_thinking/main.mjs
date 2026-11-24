import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ID_RE,
  getTranscriptMeta,
  listRecentConversations,
  parseConversationTranscript,
} from './parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NO_STORE = { 'Cache-Control': 'no-store' };

const STATIC_FILES = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch {}

  const candidates = [
    path.join(os.homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'index.mjs'),
    path.join(os.homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return await import(pathToFileURL(p).href);
      } catch {}
    }
  }
  return null;
}

function handleConversations(data) {
  const limit = Math.min(Math.max(parseInt(data?.limit || '20', 10) || 20, 1), 50);
  return {
    conversations: listRecentConversations(limit),
  };
}

function handleTranscript(data, defaultConvId = '') {
  const requested = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
  const recent = listRecentConversations(1)[0]?.id || '';
  const convId = requested || defaultConvId || recent;

  if (!convId || !ID_RE.test(convId)) {
    return { found: false, conversationId: convId || null };
  }

  const meta = getTranscriptMeta(convId);
  if (!meta) {
    return { found: false, conversationId: convId };
  }

  if (data?.etag && data.etag === meta.etag) {
    return { found: true, conversationId: convId, unchanged: true, etag: meta.etag };
  }

  return parseConversationTranscript(convId);
}

const sdk = await loadSidecarSdk();
const isSidecarEnv = Boolean(
  sdk?.SidecarApp &&
  process.env.ANTIGRAVITY_LS_ADDRESS &&
  process.env.ANTIGRAVITY_CSRF_TOKEN &&
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
);

if (isSidecarEnv) {
  const { SidecarApp, Response } = sdk;
  const app = new SidecarApp();

  app.page(
    '/',
    () =>
      new Response(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), {
        contentType: 'text/html; charset=utf-8',
        headers: NO_STORE,
      })
  );

  for (const [route, [file, contentType]] of Object.entries(STATIC_FILES)) {
    app.api(
      route,
      () =>
        new Response(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
          contentType,
          headers: NO_STORE,
        }),
      'GET'
    );
  }

  app.api('/api/conversations', (data) => handleConversations(data), 'GET');
  app.api('/api/transcript', (data) => handleTranscript(data, app.config?.conversationId || ''), 'GET');

  app.run();
} else {
  // Standalone local HTTP fallback (useful for direct testing outside Antigravity host)
  const port = parseInt(process.env.PORT || '8765', 10);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const query = Object.fromEntries(url.searchParams.entries());

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE });
      res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
      return;
    }
    if (url.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', ...NO_STORE });
      res.end('window.sidecar = window.sidecar || {};');
      return;
    }
    if (STATIC_FILES[url.pathname]) {
      const [file, contentType] = STATIC_FILES[url.pathname];
      res.writeHead(200, { 'Content-Type': contentType, ...NO_STORE });
      res.end(fs.readFileSync(path.join(__dirname, file), 'utf8'));
      return;
    }
    if (url.pathname === '/api/conversations') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE });
      res.end(JSON.stringify(handleConversations(query)));
      return;
    }
    if (url.pathname === '/api/transcript') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE });
      res.end(JSON.stringify(handleTranscript(query, '')));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Brain Live standalone server listening on http://127.0.0.1:${port}`);
  });
}
