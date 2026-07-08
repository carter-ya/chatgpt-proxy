import express, { type Request, type Response } from 'express';
import { chromium, type BrowserContext, type Page } from 'playwright';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';

// ---- Configuration ----

const PORT = parseInt(process.env.XIAOMING_SIDECAR_PORT || '3100', 10);
const CHATGPT_URL = 'https://chatgpt.com';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const LOGIN_POLL_INTERVAL_MS = 5000; // 5 seconds

// ---- Global State ----

let browserContext: BrowserContext | null = null;
let proxyPage: Page | null = null;
let isReady = false;
let readyError: string | null = null;

// Track active SSE streams so the exposed browser callback can route chunks
// to the correct Express response.
const activeStreams = new Map<string, Response>();

// Sentinel token cache — pre-fetched on startup, refreshed every 5 minutes.
// null means the initial fetch failed; proxy requests proceed without sentinel (non-fatal).
let sentinelCache: Record<string, string> | null = null;
let sentinelRefreshTimer: ReturnType<typeof setInterval> | null = null;

// ---- Helpers ----

/** Check whether the current page shows a login button (not logged in). */
async function checkLoginStatus(page: Page): Promise<boolean> {
  // Guard: if we're stuck on a Cloudflare challenge page, we're definitely not logged in.
  const pageTitle = await page.title();
  if (pageTitle.includes('Just a moment') || pageTitle.includes('请稍候')) {
    return false;
  }

  // When not logged in, chatgpt.com shows a login button in the header/landing area.
  // This selector matches both <button> and <a> elements with "Log in" text.
  const loginButton = await page.$('button:has-text("Log in"), a:has-text("Log in")');
  if (loginButton !== null) {
    return false;
  }

  // Final validation: verify the session is actually valid by making a test API call.
  // Cookies may be present but stale — the page renders normally but API calls return 401.
  // Use page.evaluate() so the fetch runs in the browser context with Chrome's cookies and TLS.
  const apiCheck = await page.evaluate(async () => {
    try {
      const resp = await fetch('/backend-api/me');
      return { status: resp.status };
    } catch {
      return { status: 0 };
    }
  });
  return apiCheck.status === 200;
}

/** Launch a visible Chrome window, wait for the user to log in manually. */
async function waitForManualLogin(userDataDir: string): Promise<void> {
  const loginContext = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const loginPage = await loginContext.newPage();
  await loginPage.goto(CHATGPT_URL, { waitUntil: 'load', timeout: 30000 });

  console.log('[sidecar] Waiting for manual login (timeout: 5 minutes)...');
  console.log('[sidecar] Please log in to chatgpt.com in the opened Chrome window.');

  const startTime = Date.now();

  while (Date.now() - startTime < LOGIN_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_INTERVAL_MS));

    try {
      await loginPage.reload({ waitUntil: 'networkidle', timeout: 15000 });
    } catch {
      // Reload may fail if the page is navigating; retry on next poll.
      continue;
    }

    const loggedIn = await checkLoginStatus(loginPage);
    if (loggedIn) {
      console.log('[sidecar] Manual login detected!');
      await loginContext.close();
      return;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[sidecar] Still waiting for login... (${elapsed}s elapsed)`);
  }

  await loginContext.close();
  throw new Error('Manual login timed out after 5 minutes');
}

// ---- Browser Initialization ----

async function initializeBrowser(): Promise<void> {
  const userDataDir = path.resolve('./.browser-profile');
  console.log(`[sidecar] Browser profile directory: ${userDataDir}`);

  // Step 1 — check existing session (non-headless Chrome required for Cloudflare bypass)
  console.log('[sidecar] Launching Chrome to check login status...');
  browserContext = await chromium.launchPersistentContext(userDataDir, {
    // MUST be non-headless: headless Chrome cannot pass Cloudflare's JS challenge on chatgpt.com.
    // The page would be stuck on "Just a moment..." indefinitely in headless mode.
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  proxyPage = await browserContext.newPage();

  // Disable CSP via Chrome DevTools Protocol so that page.evaluate() + fetch()
  // can run without being blocked by chatgpt.com's strict nonce-based CSP.
  const cdp = await browserContext.newCDPSession(proxyPage);
  await cdp.send('Page.setBypassCSP', { enabled: true });

  try {
    await proxyPage.goto(CHATGPT_URL, { waitUntil: 'load', timeout: 30000 });

    // Detect Cloudflare challenge page (headless: false usually avoids this, but guard anyway).
    let title = await proxyPage.title();
    if (title.includes('Just a moment') || title.includes('请稍候')) {
      console.log('[sidecar] Cloudflare challenge detected, waiting up to 10s...');
      await proxyPage.waitForTimeout(10_000);
      title = await proxyPage.title();
    }
  } catch (err) {
    console.warn('[sidecar] Initial navigation to chatgpt.com failed:', err);
  }

  const loggedIn = await checkLoginStatus(proxyPage);

  if (loggedIn) {
    console.log('[sidecar] Already logged in to chatgpt.com — reusing existing session.');
  } else {
    console.log('[sidecar] Not logged in. Opening visible browser for manual login...');

    // Close current headless context
    await browserContext.close();
    browserContext = null;
    proxyPage = null;

    // Open visible browser, wait for user to log in
    await waitForManualLogin(userDataDir);

    // Relaunch with persistent profile (now has valid cookies) — keep non-headless for Cloudflare
    console.log('[sidecar] Login successful. Relaunching browser...');
    browserContext = await chromium.launchPersistentContext(userDataDir, {
      // MUST remain non-headless: Cloudflare challenge would block headless mode.
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    proxyPage = await browserContext.newPage();

    // Disable CSP via Chrome DevTools Protocol so that page.evaluate() + fetch()
    // can run without being blocked by chatgpt.com's strict nonce-based CSP.
    const cdp2 = await browserContext.newCDPSession(proxyPage);
    await cdp2.send('Page.setBypassCSP', { enabled: true });

    // Verify the session is still good
    try {
      await proxyPage.goto(CHATGPT_URL, { waitUntil: 'load', timeout: 30000 });

      // Guard against Cloudflare challenge page after login.
      let title = await proxyPage.title();
      if (title.includes('Just a moment') || title.includes('请稍候')) {
        console.log('[sidecar] Cloudflare challenge detected post-login, waiting up to 10s...');
        await proxyPage.waitForTimeout(10_000);
        title = await proxyPage.title();
      }
    } catch (err) {
      console.warn('[sidecar] Post-login navigation to chatgpt.com failed:', err);
    }

    const stillLoggedIn = await checkLoginStatus(proxyPage);
    if (!stillLoggedIn) {
      throw new Error('Login verification failed after manual login — session not persisted');
    }
  }

  // Expose the stream-chunk callback into the browser page.
  // The browser side calls this with (streamId, chunk, done) for each SSE chunk.
  await proxyPage.exposeFunction(
    '__sidecarStreamChunk',
    (streamId: string, chunk: string, done: boolean) => {
      const res = activeStreams.get(streamId);
      if (!res || res.writableEnded) return;
      if (chunk) res.write(chunk);
      if (done) {
        res.end();
        activeStreams.delete(streamId);
      }
    },
  );

  isReady = true;
  console.log('[sidecar] Browser ready — accepting proxy requests.');

  // Pre-fetch sentinel tokens in the background (non-blocking).
  refreshSentinelTokens(proxyPage!)
    .catch((err) => {
      console.warn(
        '[sidecar] Initial sentinel pre-fetch failed (non-fatal, cache stays null):',
        err.message || String(err),
      );
    });

  // Refresh sentinel tokens every 5 minutes.
  sentinelRefreshTimer = setInterval(() => {
    refreshSentinelTokens(proxyPage!).catch((err) => {
      console.warn(
        '[sidecar] Sentinel refresh failed (non-fatal):',
        err.message || String(err),
      );
    });
  }, 5 * 60 * 1000);
}

// ---- Sentinel Token Helpers ----

// checkDifficulty verifies that the first difficulty bits of hash are all 0.
function checkDifficulty(hash: Uint8Array, difficulty: number): boolean {
  const fullBytes = Math.floor(difficulty / 8);
  const remBits = difficulty % 8;

  for (let i = 0; i < fullBytes; i++) {
    if (hash[i] !== 0) return false;
  }

  if (remBits > 0 && fullBytes < hash.length) {
    if ((hash[fullBytes] >> (8 - remBits)) !== 0) return false;
  }

  return true;
}

// solvePoW finds a nonce such that SHA256(seed+nonce) has the first difficulty bits set to 0.
// Returns the nonce and the hex-encoded hash as the answer.
function solvePoW(seed: string, difficulty: number): { nonce: number; answer: string } {
  for (let nonce = 0; nonce < Number.MAX_SAFE_INTEGER; nonce++) {
    const input = seed + nonce.toString();
    const hash = createHash('sha256').update(input).digest();

    if (checkDifficulty(hash, difficulty)) {
      return { nonce, answer: hash.toString('hex') };
    }
  }

  return { nonce: 0, answer: '' };
}

// Hard timeout guard for page.evaluate() calls — prevents indefinite hangs
// when the browser-side fetch hits a Cloudflare 403 challenge page.
const SENTINEL_TIMEOUT_MS = 10_000;

function withSentinelTimeout<T>(promise: Promise<T>, step: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`sentinel ${step} timed out after ${SENTINEL_TIMEOUT_MS / 1000}s`)),
        SENTINEL_TIMEOUT_MS,
      ),
    ),
  ]);
}

// fetchSentinelTokens returns the cached sentinel headers — it NEVER blocks.
// The cache is populated on startup and refreshed every 5 minutes in the background.
// Returns null when the cache hasn't been populated yet or the initial fetch failed.
function fetchSentinelTokens(): Record<string, string> | null {
  return sentinelCache;
}

// refreshSentinelTokens executes the sentinel flow (prepare → PoW → finalize)
// inside the Chrome browser context and updates the module-level sentinelCache.
// Each page.evaluate() call is guarded by a hard 10s timeout to prevent indefinite hangs.
// Called once on startup and periodically via setInterval.
async function refreshSentinelTokens(page: Page): Promise<void> {
  // Step 1 — prepare (with 10s timeout)
  const prepResult = await withSentinelTimeout(
    page.evaluate(async () => {
      try {
        const resp = await fetch('/backend-api/sentinel/chat-requirements/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ persona: 'chatgpt-freeaccount' }),
          credentials: 'include' as RequestCredentials,
        });
        if (!resp.ok) {
          const body = await resp.text();
          return { error: `prepare status ${resp.status}: ${body}` };
        }
        const data = await resp.json();
        return { data };
      } catch (err: any) {
        return { error: `prepare fetch failed: ${err.message || String(err)}` };
      }
    }),
    'prepare',
  );

  if ('error' in prepResult) {
    console.warn('[sidecar] Sentinel prepare failed:', prepResult.error);
    return;
  }

  const prepData = prepResult.data as any;

  // Step 2 — compute PoW in Node.js (avoid blocking the browser evaluate loop)
  const difficulty = parseInt(prepData.proofofwork.difficulty, 10);
  if (isNaN(difficulty) || difficulty <= 0) {
    console.warn('[sidecar] Sentinel PoW: invalid difficulty', prepData.proofofwork.difficulty);
    return;
  }
  const { answer } = solvePoW(prepData.proofofwork.seed, difficulty);

  if (!answer) {
    console.warn('[sidecar] Sentinel PoW: failed to find solution');
    return;
  }

  // Step 3 — finalize (with 10s timeout)
  const finalizeBody: any = {
    prepare_token: prepData.prepare_token,
    proofofwork: {
      seed: prepData.proofofwork.seed,
      difficulty: prepData.proofofwork.difficulty,
      answer,
    },
    turnstile: {},
  };

  if (prepData.turnstile?.required) {
    finalizeBody.turnstile = {
      token: 'cftoken',
      iframe: false,
      challenge: '',
      response: 'AAAA',
      action: 'response',
      theme: 'dark',
    };
  }

  const finResult = await withSentinelTimeout(
    page.evaluate(async (finBody) => {
      try {
        const resp = await fetch('/backend-api/sentinel/chat-requirements/finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(finBody),
          credentials: 'include' as RequestCredentials,
        });
        if (!resp.ok) {
          const body = await resp.text();
          return { error: `finalize status ${resp.status}: ${body}` };
        }
        const data = await resp.json();
        return { data };
      } catch (err: any) {
        return { error: `finalize fetch failed: ${err.message || String(err)}` };
      }
    }, finalizeBody),
    'finalize',
  );

  if ('error' in finResult) {
    console.warn('[sidecar] Sentinel finalize failed:', finResult.error);
    return;
  }

  const finData = finResult.data as any;

  sentinelCache = {
    'openai-sentinel-chat-requirements-token': finData.token,
    'openai-sentinel-proof-token': answer,
  };

  console.log('[sidecar] Sentinel tokens fetched and cached successfully');
}

// ---- Proxy Handlers ----

interface ProxyRequestBody {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Non-streaming proxy: evaluate fetch() in browser, return full response. */
async function handleNonStreamProxy(
  page: Page,
  method: string,
  upstreamPath: string,
  headers: Record<string, string>,
  body: string | undefined,
  res: Response,
): Promise<void> {
  // Strip Authorization header — the browser context manages its own OAuth2 token
  delete headers['authorization'];
  delete headers['Authorization'];

  // Decode base64-encoded body from Go before passing to browser fetch()
  const decodedBody = body ? Buffer.from(body, 'base64').toString('utf-8') : undefined;

  // Inject cached sentinel tokens for conversation requests (non-blocking, non-fatal).
  if (upstreamPath.startsWith('/backend-api/f/conversation') && sentinelCache) {
    Object.assign(headers, sentinelCache);
  }

  const result = await page.evaluate(
    async ({ method, path: p, headers: hdrs, body: b }) => {
      const url = 'https://chatgpt.com' + p;
      const fetchOptions: RequestInit = {
        method: method || 'POST',
        headers: hdrs || {},
        credentials: 'include' as RequestCredentials,
      };
      if (b !== undefined && b !== null && method !== 'GET' && method !== 'HEAD') {
        fetchOptions.body = b;
      }

      const resp = await fetch(url, fetchOptions);
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((value: string, key: string) => {
        respHeaders[key] = value;
      });
      const respBody = await resp.text();

      return {
        status: resp.status,
        headers: respHeaders,
        body: respBody,
      };
    },
    { method, path: upstreamPath, headers, body: decodedBody },
  );

  // Re-encode response body as base64 for Go side
  if (result.body) {
    result.body = Buffer.from(result.body).toString('base64');
  }

  res.json(result);
}

/** Streaming SSE proxy: evaluate fetch() in browser, relay chunks via exposed callback. */
async function handleStreamProxy(
  page: Page,
  method: string,
  upstreamPath: string,
  headers: Record<string, string>,
  body: string | undefined,
  req: Request,
  res: Response,
): Promise<void> {
  const streamId = randomUUID();

  // Strip Authorization header — the browser context manages its own OAuth2 token
  delete headers['authorization'];
  delete headers['Authorization'];

  // Decode base64-encoded body from Go before passing to browser fetch()
  const decodedBody = body ? Buffer.from(body, 'base64').toString('utf-8') : undefined;

  // Inject cached sentinel tokens for conversation requests (non-blocking, non-fatal).
  if (upstreamPath.startsWith('/backend-api/f/conversation') && sentinelCache) {
    Object.assign(headers, sentinelCache);
  }

  // Write SSE response headers immediately
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  activeStreams.set(streamId, res);

  // Clean up on client disconnect
  req.on('close', () => {
    activeStreams.delete(streamId);
  });

  // Fire-and-forget: the browser evaluate runs in the background and calls
  // __sidecarStreamChunk for each chunk.
  page
    .evaluate(
      async ({ method, path: p, headers: hdrs, body: b, streamId: sid }) => {
        const win = window as any;
        try {
          const url = 'https://chatgpt.com' + p;
          const fetchOptions: RequestInit = {
            method: method || 'POST',
            headers: hdrs || {},
            credentials: 'include' as RequestCredentials,
          };
          if (b !== undefined && b !== null && method !== 'GET' && method !== 'HEAD') {
            fetchOptions.body = b;
          }

          const resp = await fetch(url, fetchOptions);

          if (!resp.ok) {
            const errorBody = await resp.text();
            await win.__sidecarStreamChunk(
              sid,
              `event: error\ndata: HTTP ${resp.status}: ${errorBody}\n\n`,
              true,
            );
            return;
          }

          if (!resp.body) {
            await win.__sidecarStreamChunk(
              sid,
              'event: error\ndata: No response body\n\n',
              true,
            );
            return;
          }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (text) await win.__sidecarStreamChunk(sid, text, false);
          }

          // Flush any remaining bytes
          const remaining = decoder.decode();
          if (remaining) await win.__sidecarStreamChunk(sid, remaining, false);

          // Signal completion
          await win.__sidecarStreamChunk(sid, '', true);
        } catch (err: any) {
          await win.__sidecarStreamChunk(
            sid,
            `event: error\ndata: ${err.message || 'Unknown error'}\n\n`,
            true,
          );
        }
      },
      { method, path: upstreamPath, headers, body: decodedBody, streamId },
    )
    .catch((err) => {
      console.error('[sidecar] Stream evaluate rejected:', err);
      const res = activeStreams.get(streamId);
      if (res && !res.writableEnded) {
        res.write(`event: error\ndata: ${err.message}\n\n`);
        res.end();
        activeStreams.delete(streamId);
      }
    });
}

// ---- Express Server ----

function startServer(): void {
  const app = express();

  // Parse JSON bodies — the outer envelope is JSON; the inner "body" field
  // is a pre-serialized string that we pass through untouched.
  app.use(express.json({ limit: '10mb' }));

  // ---- GET /health ----
  app.get('/health', (_req: Request, res: Response) => {
    if (isReady) {
      res.json({ ok: true });
    } else {
      res.status(503).json({ ok: false, error: readyError || 'Not ready' });
    }
  });

  // ---- POST /api/proxy ----
  app.post('/api/proxy', async (req: Request, res: Response) => {
    if (!isReady || !proxyPage) {
      res.status(503).json({ error: 'Sidecar not ready' });
      return;
    }

    const isStream = req.query.stream === 'true';
    const { method, path: upstreamPath, headers, body } = req.body as ProxyRequestBody;

    if (!upstreamPath) {
      res.status(400).json({ error: 'Missing "path" field in request body' });
      return;
    }

    try {
      if (isStream) {
        await handleStreamProxy(
          proxyPage,
          method || 'POST',
          upstreamPath,
          headers || {},
          body,
          req,
          res,
        );
      } else {
        await handleNonStreamProxy(
          proxyPage,
          method || 'POST',
          upstreamPath,
          headers || {},
          body,
          res,
        );
      }
    } catch (err: any) {
      console.error('[sidecar] Proxy error:', err);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Proxy request failed', detail: String(err) });
      }
    }
  });

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[sidecar] HTTP server listening on 127.0.0.1:${PORT}`);
  });
}

// ---- Main ----

async function main(): Promise<void> {
  console.log('[sidecar] Starting Playwright sidecar...');
  console.log(`[sidecar] Port: ${PORT}`);

  try {
    await initializeBrowser();
  } catch (err) {
    console.error('[sidecar] Browser initialization failed:', err);
    readyError = String(err);
    // Start the server anyway — /health will report unhealthy.
  }

  startServer();
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[sidecar] Shutting down...');
  if (sentinelRefreshTimer) {
    clearInterval(sentinelRefreshTimer);
    sentinelRefreshTimer = null;
  }
  if (browserContext) {
    await browserContext.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[sidecar] Shutting down...');
  if (sentinelRefreshTimer) {
    clearInterval(sentinelRefreshTimer);
    sentinelRefreshTimer = null;
  }
  if (browserContext) {
    await browserContext.close();
  }
  process.exit(0);
});

main().catch((err) => {
  console.error('[sidecar] Fatal error:', err);
  process.exit(1);
});
