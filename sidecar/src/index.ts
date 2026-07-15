import express, { type Request, type Response } from 'express';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import { chromium, type Browser, type BrowserContext, type Disposable, type Page } from 'playwright';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { BrowserRecoveryController } from './browserRecovery.js';
import { startRawResponse, writeRawChunk } from './rawStreamBridge.js';

// ---- Configuration ----

const PORT = parseInt(process.env.CHATGPT_PROXY_SIDECAR_PORT || '3100', 10);
const CHATGPT_URL = 'https://chatgpt.com';
const CHROME_LAUNCH_MODE = normalizeChromeLaunchMode(
  process.env.CHATGPT_PROXY_CHROME_LAUNCH_MODE || 'cdp',
);
const CHROME_LOGIN_MODE = normalizeChromeLoginMode(
  process.env.CHATGPT_PROXY_CHROME_LOGIN_MODE || 'plain',
);
const CHROME_CDP_PORT = parseInt(process.env.CHATGPT_PROXY_CHROME_CDP_PORT || '9222', 10);
const CHROME_CHANNEL = process.env.CHATGPT_PROXY_CHROME_CHANNEL || 'chrome';
const CHROME_EXECUTABLE_PATH = process.env.CHATGPT_PROXY_CHROME_EXECUTABLE_PATH || '';
const CHROME_USER_DATA_DIR = process.env.CHATGPT_PROXY_CHROME_USER_DATA_DIR || '';
const CHROME_PROFILE_DIRECTORY = process.env.CHATGPT_PROXY_CHROME_PROFILE_DIRECTORY || '';
const CHROME_PROXY_SERVER = process.env.CHATGPT_PROXY_CHROME_PROXY_SERVER || '';
const CHROME_PROXY_BYPASS_LIST = process.env.CHATGPT_PROXY_CHROME_PROXY_BYPASS_LIST || '';
const CHROME_HOST_RESOLVER_RULES = process.env.CHATGPT_PROXY_CHROME_HOST_RESOLVER_RULES || '';
const CHROME_BYPASS_CSP = process.env.CHATGPT_PROXY_CHROME_BYPASS_CSP === 'true';
const LOGIN_TIMEOUT_MS = parseInt(process.env.CHATGPT_PROXY_LOGIN_TIMEOUT_MS || '900000', 10);
const LOGIN_POLL_INTERVAL_MS = 5000; // 5 seconds
const LOGIN_API_CHECK_INTERVAL_MS = 15_000;
const CDP_STARTUP_TIMEOUT_MS = 20_000;
const BROWSER_RECOVERY_WAIT_MS = 20_000;
const BROWSER_WATCHDOG_INTERVAL_MS = 10_000;
const CHALLENGE_OPEN_THROTTLE_MS = 30_000;
const SENTINEL_CACHE_TTL_MS = parseInt(process.env.CHATGPT_PROXY_SENTINEL_CACHE_TTL || '300', 10) * 1000;
const BROWSER_AUTH_CACHE_TTL_MS = parseInt(
  process.env.CHATGPT_PROXY_BROWSER_AUTH_CACHE_TTL_MS || '60000',
  10,
);

// ---- Global State ----

let browserSession: BrowserSession | null = null;
let browserContext: BrowserContext | null = null;
let proxyPage: Page | null = null;
let isReady = false;
let readyError: string | null = null;
let lastChallengeOpenAt = 0;
let streamChunkBinding: Disposable | null = null;
let rawStreamBinding: Disposable | null = null;
let recoveryController: BrowserRecoveryController | null = null;
let browserWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let browserWatchdogRunning = false;
let shuttingDown = false;

// Track active SSE streams so the exposed browser callback can route chunks
// to the correct Express response.
interface StreamState {
  res: Response;
  heartbeat: ReturnType<typeof setInterval>;
  buffer: string;
  lastContent: string;
  conversationId: string;
  doneSent: boolean;
  currentEvent: string;
  deltaDecoder: DeltaV1Decoder | null;
  imageIds: Set<string>;
  imageMode: boolean;
}

interface StreamImage {
  file_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  width: number;
  height: number;
  download_url: string;
  generation_id?: string;
  message_id?: string;
  candidate_group_message_id?: string;
}

interface StreamImageGroup {
  matched_text: string;
  aspect_ratio?: string;
  images: Array<{
    thumbnail_url: string;
    content_url: string;
    source_url?: string;
    title?: string;
    width?: number;
    height?: number;
  }>;
}

const activeStreams = new Map<string, StreamState>();

interface RawStreamState {
  res: Response;
}

const activeRawStreams = new Map<string, RawStreamState>();

function deleteActiveStream(streamId: string): void {
  const state = activeStreams.get(streamId);
  if (state) clearInterval(state.heartbeat);
  activeStreams.delete(streamId);
}

function failActiveStreams(message: string): void {
  for (const [streamId, state] of activeStreams) {
    if (!state.res.writableEnded) {
      state.res.write(`event: error\ndata: ${message}\n\n`);
      state.res.end();
    }
    deleteActiveStream(streamId);
  }
}

function deleteActiveRawStream(streamId: string): void {
  activeRawStreams.delete(streamId);
}

function failActiveRawStreams(message: string): void {
  for (const [streamId, state] of activeRawStreams) {
    if (!state.res.destroyed && !state.res.writableEnded) {
      state.res.destroy(new Error(message));
    }
    deleteActiveRawStream(streamId);
  }
}

// Sentinel token cache — pre-fetched on startup, refreshed every 5 minutes.
// null means the initial fetch failed; proxy requests proceed without sentinel (non-fatal).
let sentinelCache: Record<string, string> | null = null;
let sentinelCacheExpiresAt = 0;
let sentinelRefreshPromise: Promise<boolean> | null = null;
let sentinelRefreshTimer: ReturnType<typeof setInterval> | null = null;
let browserAuthCache: { authorization: string; expiresAt: number } | null = null;

// ---- Helpers ----

type ChromeLaunchMode = 'cdp' | 'persistent';
type ChromeLoginMode = 'plain' | 'attached';
type PersistentContextOptions = Parameters<typeof chromium.launchPersistentContext>[1];

interface BrowserSession {
  context: BrowserContext;
  mode: ChromeLaunchMode;
  browser?: Browser;
  chromeProcess?: ChildProcess;
  ownsChromeProcess: boolean;
}

interface VisibleAuthState {
  title: string;
  url: string;
  chatgptOrigin: boolean;
  authOrigin: boolean;
  cloudflareChallenge: boolean;
  loginButtonVisible: boolean;
}

interface LoginApiCheck {
  status: number;
  cfChallenge: boolean;
  authenticated: boolean;
  id: string;
  error?: string;
  parseError?: string;
}

interface BrowserAuthSessionResult {
  status: number;
  authorization: string;
  error?: string;
  parseError?: string;
}

interface DeltaOperation {
  channel?: number;
  c?: number;
  path?: string;
  p?: string;
  op?: string;
  o?: string;
  value?: unknown;
  v?: unknown;
}

interface ExpandedDeltaOperation {
  channel: number;
  path: string;
  op: string;
  value?: unknown;
}

function normalizeChromeLaunchMode(value: string): ChromeLaunchMode {
  if (value === 'persistent' || value === 'cdp') return value;
  console.warn(`[sidecar] Unknown CHATGPT_PROXY_CHROME_LAUNCH_MODE=${value}; using cdp.`);
  return 'cdp';
}

function normalizeChromeLoginMode(value: string): ChromeLoginMode {
  if (value === 'plain' || value === 'attached') return value;
  console.warn(`[sidecar] Unknown CHATGPT_PROXY_CHROME_LOGIN_MODE=${value}; using plain.`);
  return 'plain';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChildExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function loginTimeoutMinutes(): number {
  return Math.max(1, Math.round(LOGIN_TIMEOUT_MS / 60_000));
}

function browserLaunchOptions(): PersistentContextOptions {
  const args = ['--no-sandbox', '--disable-setuid-sandbox'];
  appendChromeNetworkArgs(args);

  const options: PersistentContextOptions = {
    // Keep a visible browser so the user can handle interactive login/challenge flows.
    headless: false,
    args,
  };

  if (CHROME_EXECUTABLE_PATH) {
    options.executablePath = CHROME_EXECUTABLE_PATH;
  } else if (CHROME_CHANNEL) {
    options.channel = CHROME_CHANNEL;
  }

  return options;
}

function appendChromeNetworkArgs(args: string[]): void {
  if (CHROME_PROXY_SERVER) {
    args.push(`--proxy-server=${CHROME_PROXY_SERVER}`);
  }
  if (CHROME_PROXY_BYPASS_LIST) {
    args.push(`--proxy-bypass-list=${CHROME_PROXY_BYPASS_LIST}`);
  }
  if (CHROME_HOST_RESOLVER_RULES) {
    args.push(`--host-resolver-rules=${CHROME_HOST_RESOLVER_RULES}`);
  }
}

async function launchPersistentBrowserSession(userDataDir: string): Promise<BrowserSession> {
  try {
    const context = await chromium.launchPersistentContext(userDataDir, browserLaunchOptions());
    return { context, mode: 'persistent', ownsChromeProcess: true };
  } catch (err) {
    if (CHROME_EXECUTABLE_PATH || CHROME_CHANNEL !== 'chrome') {
      throw err;
    }

    console.warn(
      '[sidecar] Failed to launch local Chrome Stable via channel=chrome; falling back to Playwright Chromium:',
      err,
    );
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    return { context, mode: 'persistent', ownsChromeProcess: true };
  }
}

function chromeExecutableCandidates(): string[] {
  const candidates: string[] = [];

  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(
        process.env.HOME || '',
        'Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ),
    );
  } else if (process.platform === 'win32') {
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter((root): root is string => Boolean(root));
    for (const root of roots) {
      candidates.push(path.join(root, 'Google/Chrome/Application/chrome.exe'));
    }
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
  }

  return candidates;
}

function resolveChromeExecutablePath(): string {
  if (CHROME_EXECUTABLE_PATH) return CHROME_EXECUTABLE_PATH;

  const candidate = chromeExecutableCandidates().find((item) => item && fs.existsSync(item));
  if (candidate) return candidate;

  throw new Error(
    'Google Chrome executable not found. Set CHATGPT_PROXY_CHROME_EXECUTABLE_PATH to the Chrome Stable executable path.',
  );
}

function resolveChromeUserDataDir(): string {
  if (CHROME_USER_DATA_DIR) {
    return path.resolve(CHROME_USER_DATA_DIR);
  }
  return path.resolve('./.browser-profile');
}

function verifiedLoginMarkerPath(userDataDir: string): string {
  const profile = CHROME_PROFILE_DIRECTORY || 'Default';
  const safeProfile = profile.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(userDataDir, `.sidecar-login-verified-${safeProfile}`);
}

function hasVerifiedLoginMarker(userDataDir: string): boolean {
  return fs.existsSync(verifiedLoginMarkerPath(userDataDir));
}

function writeVerifiedLoginMarker(userDataDir: string): void {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      verifiedLoginMarkerPath(userDataDir),
      JSON.stringify({ verifiedAt: new Date().toISOString(), profile: CHROME_PROFILE_DIRECTORY || 'Default' }),
    );
  } catch (err) {
    console.warn('[sidecar] Failed to write login verification marker:', err);
  }
}

function removeVerifiedLoginMarker(userDataDir: string): void {
  try {
    fs.rmSync(verifiedLoginMarkerPath(userDataDir), { force: true });
  } catch (err) {
    console.warn('[sidecar] Failed to remove login verification marker:', err);
  }
}

async function readCdpVersion(port: number): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clearBrowserAuthCache(): void {
  browserAuthCache = null;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (existing) {
    headers[existing] = value;
    return;
  }
  headers[name] = value;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  const normalized = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === normalized) {
      delete headers[key];
    }
  }
}

async function getBrowserAuthorizationHeader(page: Page): Promise<string | null> {
  if (browserAuthCache && Date.now() < browserAuthCache.expiresAt) {
    return browserAuthCache.authorization;
  }

  const session: BrowserAuthSessionResult = await page.evaluate(async () => {
    try {
      const resp = await fetch('/api/auth/session', {
        credentials: 'include',
        cache: 'no-store',
      });
      const body = await resp.text();
      let payload: any = {};
      let parseError = '';
      if (body) {
        try {
          payload = JSON.parse(body);
        } catch (err: any) {
          parseError = err.message || String(err);
        }
      }

      const rawToken = [
        payload?.accessToken,
        payload?.access_token,
        payload?.token,
        payload?.user?.accessToken,
        payload?.user?.access_token,
      ].find((value) => typeof value === 'string' && value.length > 0);
      const authorization = rawToken
        ? rawToken.startsWith('Bearer ')
          ? rawToken
          : `Bearer ${rawToken}`
        : '';

      return {
        status: resp.status,
        authorization,
        parseError,
      };
    } catch (err: any) {
      return {
        status: 0,
        authorization: '',
        error: err.message || String(err),
      };
    }
  });

  if (session.authorization) {
    browserAuthCache = {
      authorization: session.authorization,
      expiresAt: Date.now() + BROWSER_AUTH_CACHE_TTL_MS,
    };
    return session.authorization;
  }

  clearBrowserAuthCache();
  if (session.status === 0) {
    console.warn('[sidecar] Browser auth session request failed:', session.error);
  } else if (session.parseError) {
    console.warn('[sidecar] Browser auth session response was not valid JSON:', session.parseError);
  } else {
    console.warn(
      `[sidecar] Browser auth session did not expose an access token (HTTP ${session.status}); request will rely on cookies only.`,
    );
  }
  return null;
}

async function applyBrowserAuthHeaders(page: Page, headers: Record<string, string>): Promise<void> {
  delete headers.authorization;
  delete headers.Authorization;

  const authorization = await getBrowserAuthorizationHeader(page);
  if (authorization && !hasHeader(headers, 'authorization')) {
    setHeader(headers, 'Authorization', authorization);
  }
}

async function waitForCdp(port: number, timeoutMs: number, getSpawnError: () => Error | null): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const spawnError = getSpawnError();
    if (spawnError) throw spawnError;

    const version = await readCdpVersion(port);
    if (typeof version?.webSocketDebuggerUrl === 'string') {
      return;
    }

    await sleep(250);
  }

  throw new Error(`Chrome CDP endpoint did not become ready on 127.0.0.1:${port}`);
}

function markReadyBrowserUnavailable(message: string): void {
  const wasReady = isReady;
  isReady = false;
  readyError = message;
  clearBrowserAuthCache();
  if (wasReady) {
    failActiveStreams(message);
    failActiveRawStreams(message);
    console.warn(`[sidecar] ${message}`);
  }
}

function reportBrowserUnavailable(message: string): void {
  markReadyBrowserUnavailable(message);
  if (!shuttingDown) {
    void recoveryController?.request(message);
  }
}

async function handleCdpChromeExit(
  chromeProcess: ChildProcess,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  if (browserSession?.chromeProcess !== chromeProcess || !isReady) {
    return;
  }

  if (code === 0 && signal === null) {
    await sleep(500);
    if (browserSession?.chromeProcess !== chromeProcess || !isReady) {
      return;
    }

    const version = await readCdpVersion(CHROME_CDP_PORT);
    if (version) {
      console.warn(
        '[sidecar] Chrome launcher process exited cleanly while CDP is still reachable; keeping browser session ready.',
      );
      return;
    }

    reportBrowserUnavailable(
      'Chrome was closed; leave the sidecar Chrome window open while using proxy mode.',
    );
    return;
  }

  reportBrowserUnavailable(`Chrome exited unexpectedly (code=${code}, signal=${signal})`);
}

function spawnCdpChrome(executablePath: string, userDataDir: string, port: number): {
  process: ChildProcess;
  getSpawnError: () => Error | null;
} {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (CHROME_PROFILE_DIRECTORY) {
    args.splice(2, 0, `--profile-directory=${CHROME_PROFILE_DIRECTORY}`);
  }
  appendChromeNetworkArgs(args);
  args.push(CHATGPT_URL);
  let spawnError: Error | null = null;

  const chromeProcess = spawn(executablePath, args, {
    detached: false,
    stdio: 'ignore',
  });

  chromeProcess.once('error', (err) => {
    spawnError = err;
  });

  chromeProcess.once('exit', (code, signal) => {
    void handleCdpChromeExit(chromeProcess, code, signal);
  });

  return {
    process: chromeProcess,
    getSpawnError: () => spawnError,
  };
}

function plainChromeLoginArgs(userDataDir: string): string[] {
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
  ];
  if (CHROME_PROFILE_DIRECTORY) {
    args.splice(1, 0, `--profile-directory=${CHROME_PROFILE_DIRECTORY}`);
  }
  appendChromeNetworkArgs(args);
  args.push(CHATGPT_URL);
  return args;
}

function activatePlainChromeLoginWindow(): void {
  if (process.platform !== 'darwin') return;

  const script = [
    'tell application "Google Chrome"',
    'activate',
    'if (count of windows) > 0 then set index of window 1 to 1',
    'end tell',
  ].join('\n');

  const activation = spawn('/usr/bin/osascript', ['-e', script], {
    detached: false,
    stdio: 'ignore',
  });
  activation.once('error', (err) => {
    console.warn('[sidecar] Failed to activate plain Chrome login window:', err);
  });
}

async function runPlainChromeLogin(userDataDir: string): Promise<void> {
  const executablePath = resolveChromeExecutablePath();
  const args = plainChromeLoginArgs(userDataDir);
  const timeoutMs = LOGIN_TIMEOUT_MS;
  const startedAt = Date.now();

  console.log('[sidecar] Opening plain Chrome for login with no CDP/debugger attached.');
  console.log(
    `[sidecar] Complete ChatGPT login in that Chrome window, then quit Chrome to continue (timeout: ${loginTimeoutMinutes()} minutes).`,
  );

  const chromeProcess = spawn(executablePath, args, {
    detached: false,
    stdio: 'ignore',
  });
  setTimeout(activatePlainChromeLoginWindow, 1000);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        if (!chromeProcess.killed) chromeProcess.kill('SIGTERM');
        reject(err);
        return;
      }
      resolve();
    };

    const timer = setTimeout(() => {
      finish(new Error(`Plain Chrome login timed out after ${loginTimeoutMinutes()} minutes`));
    }, timeoutMs);

    chromeProcess.once('error', (err) => {
      finish(err);
    });

    chromeProcess.once('exit', () => {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < 3000) {
        console.warn(
          '[sidecar] Plain Chrome exited quickly. If Chrome was already running with this profile, close it fully and restart sidecar.',
        );
      }
      finish();
    });
  });
}

async function launchCdpBrowserSession(userDataDir: string): Promise<BrowserSession> {
  const existingVersion = await readCdpVersion(CHROME_CDP_PORT);
  let chromeProcess: ChildProcess | undefined;
  let ownsChromeProcess = false;
  let getSpawnError = () => null as Error | null;

  if (existingVersion) {
    console.log(`[sidecar] Connecting to existing Chrome CDP endpoint on 127.0.0.1:${CHROME_CDP_PORT}.`);
  } else {
    const executablePath = resolveChromeExecutablePath();
    console.log(`[sidecar] Launching Chrome Stable via CDP: ${executablePath}`);
    const spawned = spawnCdpChrome(executablePath, userDataDir, CHROME_CDP_PORT);
    chromeProcess = spawned.process;
    ownsChromeProcess = true;
    getSpawnError = spawned.getSpawnError;
    await waitForCdp(CHROME_CDP_PORT, CDP_STARTUP_TIMEOUT_MS, getSpawnError);
  }

  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CHROME_CDP_PORT}`);
    browser.once('disconnected', () => {
      if (browserSession?.browser !== browser || !isReady) {
        return;
      }

      reportBrowserUnavailable(
        'Chrome CDP connection disconnected; leave the sidecar Chrome window open while using proxy mode.',
      );
    });

    const context = browser.contexts()[0];
    if (!context) {
      if (ownsChromeProcess) {
        await browser.close().catch(() => undefined);
      }
      throw new Error('Connected to Chrome CDP, but no default browser context was exposed.');
    }

    return {
      context,
      browser,
      chromeProcess,
      mode: 'cdp',
      ownsChromeProcess,
    };
  } catch (err) {
    if (chromeProcess && !chromeProcess.killed) chromeProcess.kill('SIGTERM');
    throw err;
  }
}

async function launchBrowserSession(userDataDir: string): Promise<BrowserSession> {
  if (CHROME_LAUNCH_MODE === 'persistent') {
    return launchPersistentBrowserSession(userDataDir);
  }
  return launchCdpBrowserSession(userDataDir);
}

async function closeBrowserSession(session: BrowserSession | null): Promise<void> {
  if (!session) return;

  if (session.mode === 'cdp' && session.browser) {
    if (session.ownsChromeProcess) {
      try {
        await session.browser.close();
      } catch {
        // The process is killed below if closing over CDP fails.
      }
    }
  } else {
    await session.context.close().catch(() => undefined);
  }

  if (session.chromeProcess && session.chromeProcess.exitCode === null && session.chromeProcess.signalCode === null) {
    if (!session.chromeProcess.killed) {
      session.chromeProcess.kill('SIGTERM');
    }
    await waitForChildExit(session.chromeProcess);
  }
}

async function resetBrowserSession(): Promise<void> {
  const session = browserSession;
  browserSession = null;
  browserContext = null;
  proxyPage = null;
  isReady = false;
  readyError = null;
  if (streamChunkBinding) {
    await streamChunkBinding.dispose().catch(() => undefined);
    streamChunkBinding = null;
  }
  if (rawStreamBinding) {
    await rawStreamBinding.dispose().catch(() => undefined);
    rawStreamBinding = null;
  }
  await closeBrowserSession(session);
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const pages = context.pages();
  const chatPage = pages.find((page) => page.url().startsWith(CHATGPT_URL));
  return chatPage || pages[0] || context.newPage();
}

async function configureProxyPage(page: Page): Promise<void> {
  if (!CHROME_BYPASS_CSP) return;

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setBypassCSP', { enabled: true });
}

function isCloudflareChallenge(title: string, url: string): boolean {
  const normalizedTitle = title.toLowerCase();
  return (
    normalizedTitle.includes('just a moment') ||
    normalizedTitle.includes('attention required') ||
    title.includes('请稍候') ||
    url.includes('/cdn-cgi/challenge-platform')
  );
}

async function getVisibleAuthState(page: Page): Promise<VisibleAuthState> {
  const title = await page.title().catch(() => '');
  const url = page.url();
  const chatgptOrigin = url.startsWith(CHATGPT_URL);
  const authOrigin = url.startsWith('https://auth.openai.com/');
  const loginButton = await page
    .$('button:has-text("Log in"), a:has-text("Log in")')
    .catch(() => null);

  return {
    title,
    url,
    chatgptOrigin,
    authOrigin,
    cloudflareChallenge: isCloudflareChallenge(title, url),
    loginButtonVisible: loginButton !== null,
  };
}

async function openChatGPT(page: Page): Promise<void> {
  try {
    if (!page.url().startsWith(CHATGPT_URL)) {
      await page.goto(CHATGPT_URL, { waitUntil: 'load', timeout: 30000 });
    }

    const state = await getVisibleAuthState(page);
    if (state.cloudflareChallenge) {
      console.log('[sidecar] Cloudflare challenge is visible in Chrome; keeping the page open for manual completion.');
    }
  } catch (err) {
    console.warn('[sidecar] Navigation to chatgpt.com failed:', err);
  }
}

async function openCloudflareChallengePage(page: Page, upstreamPath: string): Promise<void> {
  const now = Date.now();
  if (now - lastChallengeOpenAt < CHALLENGE_OPEN_THROTTLE_MS) return;
  lastChallengeOpenAt = now;

  let challengeUrl = CHATGPT_URL;
  try {
    challengeUrl = new URL(upstreamPath || '/', CHATGPT_URL).toString();
  } catch {
    // Fall back to the ChatGPT origin when the upstream path is malformed.
  }

  console.warn(
    `[sidecar] Cloudflare challenged browser fetch for ${upstreamPath}; opening visible Chrome page: ${challengeUrl}`,
  );

  try {
    await page.goto(challengeUrl, { waitUntil: 'load', timeout: 30000 });
  } catch (err) {
    console.warn('[sidecar] Failed to open Cloudflare challenge page:', err);
  }
}

/** Check whether the current page shows a login button (not logged in). */
async function checkLoginStatus(page: Page): Promise<boolean> {
  const state = await getVisibleAuthState(page);
  if (state.cloudflareChallenge) {
    return false;
  }

  // When not logged in, chatgpt.com shows a login button in the header/landing area.
  // This selector matches both <button> and <a> elements with "Log in" text.
  if (state.loginButtonVisible) {
    return false;
  }
  if (!state.chatgptOrigin) {
    if (state.authOrigin) {
      console.log('[sidecar] Login is still on auth.openai.com; waiting without probing chatgpt backend APIs.');
    }
    return false;
  }

  // Final validation: verify the session is actually valid by making a test API call.
  // Cookies may be present but stale — the page renders normally but API calls return 401.
  // Use page.evaluate() so the fetch runs in the browser context with Chrome's cookies and TLS.
  const authorization = await getBrowserAuthorizationHeader(page);
  if (!authorization) {
    return false;
  }

  const apiCheck: LoginApiCheck = await page.evaluate(async (authHeader) => {
    const check = async (headers: Record<string, string>): Promise<LoginApiCheck> => {
      try {
        const resp = await fetch('/backend-api/me', {
          credentials: 'include',
          cache: 'no-store',
          headers,
        });
        const body = await resp.text();
        let payload: any = {};
        let parseError = '';
        if (body) {
          try {
            payload = JSON.parse(body);
          } catch (err: any) {
            parseError = err.message || String(err);
          }
        }
        const id = typeof payload?.id === 'string' ? payload.id : '';
        return {
          status: resp.status,
          cfChallenge: resp.headers.get('cf-mitigated') === 'challenge',
          authenticated: resp.status === 200 && id.length > 0 && !id.startsWith('ua-'),
          id,
          parseError,
        };
      } catch (err: any) {
        return {
          status: 0,
          cfChallenge: false,
          authenticated: false,
          id: '',
          error: err.message || String(err),
        };
      }
    };

    const withAuthorization = await check({ Authorization: authHeader });
    // Cloudflare may challenge an API request carrying a synthetic Authorization
    // header even though the normal browser session is healthy. Retry with the
    // same cookie-only request used by the ChatGPT page before treating it as a
    // login failure.
    if (withAuthorization.cfChallenge) {
      return check({});
    }
    return withAuthorization;
  }, authorization);
  if (apiCheck.cfChallenge) {
    console.warn('[sidecar] /backend-api/me returned a Cloudflare challenge.');
    await openCloudflareChallengePage(page, '/backend-api/me');
    return false;
  }
  if (apiCheck.status === 0) {
    console.warn('[sidecar] /backend-api/me failed before HTTP response:', apiCheck.error);
    return false;
  }
  if (apiCheck.status !== 200) {
    console.warn(`[sidecar] /backend-api/me returned HTTP ${apiCheck.status}; treating as not logged in.`);
    return false;
  }
  if (!apiCheck.authenticated) {
    console.warn(
      `[sidecar] /backend-api/me returned anonymous/empty profile id=${apiCheck.id || '(empty)'}; treating as not logged in.`,
    );
    if (apiCheck.parseError) {
      console.warn('[sidecar] /backend-api/me response was not valid JSON:', apiCheck.parseError);
    }
    return false;
  }
  return true;
}

/** Keep the visible Chrome window open and wait for the user to log in manually. */
async function waitForManualLogin(loginPage: Page): Promise<void> {
  console.log(`[sidecar] Waiting for manual login (timeout: ${loginTimeoutMinutes()} minutes)...`);
  console.log('[sidecar] Please log in to chatgpt.com in the opened Chrome window.');

  const startTime = Date.now();
  let nextApiCheckAt = 0;
  let lastProgressLogAt = 0;

  while (Date.now() - startTime < LOGIN_TIMEOUT_MS) {
    await sleep(LOGIN_POLL_INTERVAL_MS);

    const state = await getVisibleAuthState(loginPage);
    const now = Date.now();

    if (state.cloudflareChallenge) {
      if (now - lastProgressLogAt >= LOGIN_API_CHECK_INTERVAL_MS) {
        console.log('[sidecar] Cloudflare challenge is still visible; not reloading the page.');
        lastProgressLogAt = now;
      }
      continue;
    }

    if (!state.loginButtonVisible && now >= nextApiCheckAt) {
      nextApiCheckAt = now + LOGIN_API_CHECK_INTERVAL_MS;
      const loggedIn = await checkLoginStatus(loginPage);
      if (loggedIn) {
        console.log('[sidecar] Manual login detected!');
        return;
      }
    }

    if (now - lastProgressLogAt >= LOGIN_API_CHECK_INTERVAL_MS) {
      const elapsed = Math.round((now - startTime) / 1000);
      console.log(`[sidecar] Still waiting for login... (${elapsed}s elapsed)`);
      lastProgressLogAt = now;
    }
  }

  throw new Error(`Manual login timed out after ${loginTimeoutMinutes()} minutes`);
}

// ---- Browser Initialization ----

async function openProxyBrowser(userDataDir: string): Promise<Page> {
  browserSession = await launchBrowserSession(userDataDir);
  browserContext = browserSession.context;

  proxyPage = await getOrCreatePage(browserContext);
  await configureProxyPage(proxyPage);
  await openChatGPT(proxyPage);

  return proxyPage;
}

function watchBrowserLifecycle(session: BrowserSession, page: Page): void {
  session.context.once('close', () => {
    if (browserSession === session && isReady) {
      reportBrowserUnavailable('Chrome browser context closed; recovery is starting.');
    }
  });
  page.once('close', () => {
    if (proxyPage === page && isReady) {
      reportBrowserUnavailable('ChatGPT proxy page closed; recovery is starting.');
    }
  });
}

async function initializeBrowser(): Promise<void> {
  const userDataDir = resolveChromeUserDataDir();
  console.log(`[sidecar] Browser profile directory: ${userDataDir}`);
  if (CHROME_PROFILE_DIRECTORY) {
    console.log(`[sidecar] Chrome profile directory: ${CHROME_PROFILE_DIRECTORY}`);
  }

  if (CHROME_LOGIN_MODE === 'plain' && !hasVerifiedLoginMarker(userDataDir)) {
    console.log('[sidecar] No verified login marker found; plain Chrome login must run before CDP attach.');
    await runPlainChromeLogin(userDataDir);
  }

  // Step 1 — check existing session after any required plain-browser login.
  console.log('[sidecar] Launching Chrome to check login status...');
  let page = await openProxyBrowser(userDataDir);
  const loggedIn = await checkLoginStatus(page);

  if (loggedIn) {
    console.log('[sidecar] Already logged in to chatgpt.com — reusing existing session.');
    writeVerifiedLoginMarker(userDataDir);
  } else {
    removeVerifiedLoginMarker(userDataDir);
    console.log('[sidecar] Not logged in or upstream challenge is active. Waiting for manual completion...');

    if (CHROME_LOGIN_MODE === 'plain') {
      await resetBrowserSession();
      await runPlainChromeLogin(userDataDir);
      console.log('[sidecar] Plain Chrome login window closed; reconnecting with CDP for proxy mode...');
      page = await openProxyBrowser(userDataDir);
      const stillLoggedIn = await checkLoginStatus(page);
      if (!stillLoggedIn) {
        removeVerifiedLoginMarker(userDataDir);
        throw new Error('Login verification failed after plain Chrome login — session not usable');
      }
      writeVerifiedLoginMarker(userDataDir);
    } else {
      await waitForManualLogin(page);

      const stillLoggedIn = await checkLoginStatus(page);
      if (!stillLoggedIn) {
        removeVerifiedLoginMarker(userDataDir);
        throw new Error('Login verification failed after manual login — session not usable');
      }
      writeVerifiedLoginMarker(userDataDir);
    }
  }

  // Expose the stream-chunk callback into the browser page.
  // The browser side calls this with (streamId, chunk, done) for each SSE chunk.
  streamChunkBinding = await page.exposeFunction(
    '__sidecarStreamChunk',
    (streamId: string, chunk: string, done: boolean) => {
      const state = activeStreams.get(streamId);
      if (!state || state.res.writableEnded) return;
      if (chunk) {
        const normalized = normalizeSSEChunk(state, chunk);
        if (normalized) state.res.write(normalized);
      }
      if (done) {
        const tail = flushSSEStream(state);
        if (tail) state.res.write(tail);
        state.res.end();
        deleteActiveStream(streamId);
      }
    },
  );

  rawStreamBinding = await page.exposeFunction(
    '__sidecarRawStreamEvent',
    async (streamId: string, event: { type: string; status?: number; headers?: Record<string, string>; chunk?: string; error?: string }) => {
      const state = activeRawStreams.get(streamId);
      if (!state || state.res.destroyed || state.res.writableEnded) return false;
      switch (event.type) {
      case 'start':
        return startRawResponse(state.res, event.status || 502, event.headers || {});
      case 'chunk':
        return writeRawChunk(state.res, event.chunk || '');
      case 'done':
        state.res.end();
        deleteActiveRawStream(streamId);
        return true;
      case 'error':
        if (!state.res.headersSent) {
          state.res.status(502).json({ error: event.error || 'Raw stream failed' });
        } else {
          state.res.destroy(new Error(event.error || 'Raw stream failed'));
        }
        deleteActiveRawStream(streamId);
        return false;
      default:
        return false;
      }
    },
  );

  if (!browserSession) {
    throw new Error('Browser session disappeared during initialization');
  }
  watchBrowserLifecycle(browserSession, page);
  readyError = null;
  isReady = true;
  console.log('[sidecar] Browser ready — accepting proxy requests.');

  // Pre-fetch sentinel tokens in the background (non-blocking).
  // DISABLED: page.evaluate()→fetch() triggers Cloudflare 403 challenges that poison the Chrome session.
  // refreshSentinelTokens(proxyPage!)
  //   .catch((err) => {
  //     console.warn(
  //       '[sidecar] Initial sentinel pre-fetch failed (non-fatal, cache stays null):',
  //       err.message || String(err),
  //     );
  //   });

  // Refresh sentinel tokens every 5 minutes.
  // DISABLED: page.evaluate()→fetch() triggers Cloudflare 403 challenges that poison the Chrome session.
  // sentinelRefreshTimer = setInterval(() => {
  //   refreshSentinelTokens(proxyPage!).catch((err) => {
  //     console.warn(
  //       '[sidecar] Sentinel refresh failed (non-fatal):',
  //       err.message || String(err),
  //     );
  //   });
  // }, 5 * 60 * 1000);
}

async function recoverBrowser(): Promise<void> {
  if (shuttingDown) return;
  await resetBrowserSession();
  if (shuttingDown) return;
  await initializeBrowser();
  if (shuttingDown) await resetBrowserSession();
}

async function inspectBrowserHealth(): Promise<void> {
  if (shuttingDown || !isReady) return;
  const session = browserSession;
  const page = proxyPage;
  if (!session || !page || page.isClosed()) {
    reportBrowserUnavailable('Browser session or proxy page is no longer available.');
    return;
  }
  if (session.mode !== 'cdp') return;
  if (!session.browser?.isConnected()) {
    reportBrowserUnavailable('Chrome CDP browser connection is no longer active.');
    return;
  }
  if (!await readCdpVersion(CHROME_CDP_PORT)) {
    reportBrowserUnavailable('Chrome CDP endpoint is unreachable; recovery is starting.');
  }
}

function startBrowserWatchdog(): void {
  if (browserWatchdogTimer) return;
  browserWatchdogTimer = setInterval(() => {
    if (browserWatchdogRunning) return;
    browserWatchdogRunning = true;
    void inspectBrowserHealth()
      .catch((err) => console.warn('[sidecar] Browser watchdog failed:', err))
      .finally(() => { browserWatchdogRunning = false; });
  }, BROWSER_WATCHDOG_INTERVAL_MS);
}

// ---- Sentinel Token Helpers ----

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

async function generateRequirementsToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const encodeTokenPayload = (value: unknown): string => {
      const json = JSON.stringify(value);
      return btoa(String.fromCharCode(...new TextEncoder().encode(json)));
    };
    const randomChoice = <T>(items: T[]): T | undefined => items[Math.floor(Math.random() * items.length)];
    const randomNavigatorProbe = (): string => {
      const key = randomChoice(Object.keys(Object.getPrototypeOf(navigator)));
      if (!key) return '';
      try {
        return `${key}-${(navigator as any)[key].toString()}`;
      } catch {
        return `${key}`;
      }
    };
    const startedAt = performance.now();
    const config = [
      screen?.width + screen?.height,
      `${new Date()}`,
      (performance as any)?.memory?.jsHeapSizeLimit,
      1,
      navigator.userAgent,
      randomChoice(Array.from(document.scripts).map((item) => item?.src).filter(Boolean)),
      (Array.from(document.scripts || [])
        .map((item) => item?.src?.match('c/[^/]*/_'))
        .filter((item) => item?.length)[0] ?? [])[0] ?? document.documentElement.getAttribute('data-build'),
      navigator.language,
      navigator.languages?.join(','),
      performance.now() - startedAt,
      randomNavigatorProbe(),
      randomChoice(Object.keys(document)),
      randomChoice(Object.keys(window)),
      performance.now(),
      crypto.randomUUID(),
      [...new URLSearchParams(window.location.search).keys()].join(','),
      navigator?.hardwareConcurrency,
      performance.timeOrigin,
      Number('ai' in window),
      Number('createPRNG' in window),
      Number('cache' in window),
      Number('data' in window),
      Number('solana' in window),
      Number('dump' in window),
      Number('InstallTrigger' in window),
    ];
    return `gAAAAAC${encodeTokenPayload(config)}`;
  });
}

async function generateProofToken(
  page: Page,
  proofOfWork: { seed?: unknown; difficulty?: unknown; required?: unknown },
): Promise<string | null> {
  if (!proofOfWork?.required) return null;
  if (typeof proofOfWork.seed !== 'string') return null;

  const seed = proofOfWork.seed;
  const difficulty = String(proofOfWork.difficulty ?? '');
  if (!difficulty) return null;

  return page.evaluate(
    ({ seed, difficulty, maxAttempts }) => {
      const hash32 = (value: string): string => {
        let hash = 2166136261;
        for (let index = 0; index < value.length; index++) {
          hash ^= value.charCodeAt(index);
          hash = Math.imul(hash, 16777619) >>> 0;
        }
        hash ^= hash >>> 16;
        hash = Math.imul(hash, 2246822507) >>> 0;
        hash ^= hash >>> 13;
        hash = Math.imul(hash, 3266489909) >>> 0;
        hash ^= hash >>> 16;
        return (hash >>> 0).toString(16).padStart(8, '0');
      };
      const encodeTokenPayload = (value: unknown): string => {
        const json = JSON.stringify(value);
        return btoa(String.fromCharCode(...new TextEncoder().encode(json)));
      };
      const randomChoice = <T>(items: T[]): T | undefined => items[Math.floor(Math.random() * items.length)];
      const randomNavigatorProbe = (): string => {
        const key = randomChoice(Object.keys(Object.getPrototypeOf(navigator)));
        if (!key) return '';
        try {
          return `${key}-${(navigator as any)[key].toString()}`;
        } catch {
          return `${key}`;
        }
      };
      const startedAt = performance.now();
      const sid = crypto.randomUUID();
      const config = [
        screen?.width + screen?.height,
        `${new Date()}`,
        (performance as any)?.memory?.jsHeapSizeLimit,
        Math.random(),
        navigator.userAgent,
        randomChoice(Array.from(document.scripts).map((item) => item?.src).filter(Boolean)),
        (Array.from(document.scripts || [])
          .map((item) => item?.src?.match('c/[^/]*/_'))
          .filter((item) => item?.length)[0] ?? [])[0] ?? document.documentElement.getAttribute('data-build'),
        navigator.language,
        navigator.languages?.join(','),
        Math.random(),
        randomNavigatorProbe(),
        randomChoice(Object.keys(document)),
        randomChoice(Object.keys(window)),
        performance.now(),
        sid,
        [...new URLSearchParams(window.location.search).keys()].join(','),
        navigator?.hardwareConcurrency,
        performance.timeOrigin,
        Number('ai' in window),
        Number('createPRNG' in window),
        Number('cache' in window),
        Number('data' in window),
        Number('solana' in window),
        Number('dump' in window),
        Number('InstallTrigger' in window),
      ];

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        config[3] = attempt;
        config[9] = Math.round(performance.now() - startedAt);
        const answer = encodeTokenPayload(config);
        if (hash32(seed + answer).substring(0, difficulty.length) <= difficulty) {
          return `gAAAAAB${answer}~S`;
        }
      }

      return null;
    },
    { seed, difficulty, maxAttempts: 500_000 },
  );
}

async function generateTurnstileToken(
  page: Page,
  chatRequirements: { turnstile?: { dx?: unknown; required?: unknown } },
  requirementsToken: string,
): Promise<string | null> {
  const dx = chatRequirements.turnstile?.dx;
  if (typeof dx !== 'string' || dx.length === 0) {
    return null;
  }

  return page.evaluate(
    async ({ dx, salt }) => {
      const Iin = 0;
      const Lin = 1;
      const Rin = 2;
      const zin = 3;
      const Bin = 4;
      const Vin = 5;
      const Hin = 6;
      const Win = 7;
      const Gin = 8;
      const WI = 9;
      const Kin = 10;
      const qin = 11;
      const Jin = 12;
      const Yin = 13;
      const Xin = 14;
      const Zin = 15;
      const GI = 16;
      const Qin = 17;
      const $in = 18;
      const ean = 19;
      const nan = 20;
      const ran = 21;
      const ian = 22;
      const tan = 23;
      const Uin = 24;
      const aan = 25;
      const oan = 26;
      const san = 27;
      const can = 28;
      const lan = 29;
      const uan = 30;
      const dan = 33;
      const fan = 34;
      const pan = 35;

      const state = new Map<number, any>();
      let instructionCount = 0;
      let chain = Promise.resolve();

      const xorDecode = (value: string, key: string): string => {
        let result = '';
        for (let index = 0; index < value.length; index++) {
          result += String.fromCharCode(value.charCodeAt(index) ^ key.charCodeAt(index % key.length));
        }
        return result;
      };

      const runSerialized = <T>(callback: () => Promise<T>): Promise<T> => {
        const next = chain.then(callback, callback);
        chain = next.then(() => undefined, () => undefined);
        return next;
      };

      const runQueue = async (): Promise<void> => {
        while (state.get(WI).length > 0) {
          const [opcode, ...args] = state.get(WI).shift();
          const result = state.get(opcode)(...args);
          if (result && typeof result.then === 'function') {
            await result;
          }
          instructionCount++;
        }
      };

      const installOpcodes = (): void => {
        state.clear();
        state.set(Iin, runVmProgram);
        state.set(Lin, (target: number, key: number) =>
          state.set(target, xorDecode(String(state.get(target)), String(state.get(key)))),
        );
        state.set(Rin, (target: number, value: unknown) => state.set(target, value));
        state.set(Vin, (target: number, valueKey: number) => {
          const current = state.get(target);
          if (Array.isArray(current)) {
            current.push(state.get(valueKey));
          } else {
            state.set(target, current + state.get(valueKey));
          }
        });
        state.set(san, (target: number, valueKey: number) => {
          const current = state.get(target);
          if (Array.isArray(current)) {
            current.splice(current.indexOf(state.get(valueKey)), 1);
          } else {
            state.set(target, current - state.get(valueKey));
          }
        });
        state.set(lan, (target: number, left: number, right: number) =>
          state.set(target, state.get(left) < state.get(right)),
        );
        state.set(dan, (target: number, left: number, right: number) =>
          state.set(target, Number(state.get(left)) * Number(state.get(right))),
        );
        state.set(pan, (target: number, left: number, right: number) => {
          const numerator = Number(state.get(left));
          const denominator = Number(state.get(right));
          state.set(target, denominator === 0 ? 0 : numerator / denominator);
        });
        state.set(Hin, (target: number, objectKey: number, propertyKey: number) =>
          state.set(target, state.get(objectKey)[state.get(propertyKey)]),
        );
        state.set(Win, (functionKey: number, ...argKeys: number[]) =>
          state.get(functionKey)(...argKeys.map((key) => state.get(key))),
        );
        state.set(Qin, (target: number, functionKey: number, ...argKeys: number[]) => {
          try {
            const result = state.get(functionKey)(...argKeys.map((key) => state.get(key)));
            if (result && typeof result.then === 'function') {
              return result
                .then((value: unknown) => state.set(target, value))
                .catch((err: unknown) => state.set(target, String(err)));
            }
            state.set(target, result);
          } catch (err) {
            state.set(target, String(err));
          }
        });
        state.set(Yin, (target: number, functionKey: number, ...argKeys: number[]) => {
          try {
            state.get(functionKey)(...argKeys.map((key) => state.get(key)));
          } catch (err) {
            state.set(target, String(err));
          }
        });
        state.set(Gin, (target: number, source: number) => state.set(target, state.get(source)));
        state.set(Kin, window);
        state.set(qin, (target: number, patternKey: number) =>
          state.set(
            target,
            (Array.from(document.scripts || [])
              .map((script) => script?.src?.match(state.get(patternKey)))
              .filter((match) => match?.length)[0] ?? [])[0] ?? null,
          ),
        );
        state.set(Jin, (target: number) => state.set(target, state));
        state.set(Xin, (target: number, source: number) =>
          state.set(target, JSON.parse(String(state.get(source)))),
        );
        state.set(Zin, (target: number, source: number) =>
          state.set(target, JSON.stringify(state.get(source))),
        );
        state.set($in, (target: number) => state.set(target, atob(String(state.get(target)))));
        state.set(ean, (target: number) => state.set(target, btoa(String(state.get(target)))));
        state.set(nan, (left: number, right: number, callbackKey: number, ...argKeys: number[]) =>
          state.get(left) === state.get(right)
            ? state.get(callbackKey)(...argKeys)
            : null,
        );
        state.set(ran, (left: number, right: number, threshold: number, callbackKey: number, ...argKeys: number[]) =>
          Math.abs(state.get(left) - state.get(right)) > state.get(threshold)
            ? state.get(callbackKey)(...argKeys)
            : null,
        );
        state.set(tan, (valueKey: number, callbackKey: number, ...argKeys: number[]) =>
          state.get(valueKey) === undefined ? null : state.get(callbackKey)(...argKeys),
        );
        state.set(Uin, (target: number, objectKey: number, propertyKey: number) =>
          state.set(target, state.get(objectKey)[state.get(propertyKey)].bind(state.get(objectKey))),
        );
        state.set(fan, (target: number, promiseKey: number) => {
          try {
            return Promise.resolve(state.get(promiseKey)).then((value) => state.set(target, value));
          } catch {
            return undefined;
          }
        });
        state.set(ian, (target: number, queue: any[]) => {
          const previousQueue = [...state.get(WI)];
          return state
            .set(WI, [...queue])
            .get(WI) && runQueue()
            .catch((err) => state.set(target, String(err)))
            .finally(() => state.set(WI, previousQueue));
        });
        state.set(can, () => undefined);
        state.set(oan, () => undefined);
        state.set(aan, () => undefined);
      };

      const runVmProgram = (program: string): Promise<string> =>
        runSerialized(
          () =>
            new Promise((resolve, reject) => {
              let settled = false;
              setTimeout(() => {
                if (!settled) {
                  settled = true;
                  resolve(String(instructionCount));
                }
              }, 500);

              state.set(zin, (value: unknown) => {
                if (!settled) {
                  settled = true;
                  resolve(btoa(String(value)));
                }
              });
              state.set(Bin, (value: unknown) => {
                if (!settled) {
                  settled = true;
                  reject(btoa(String(value)));
                }
              });
              state.set(uan, (target: number, returnKey: number, bindingsOrQueue: any, maybeQueue: any) => {
                const hasBindings = Array.isArray(maybeQueue);
                const bindingKeys = hasBindings ? bindingsOrQueue : [];
                const queue = (hasBindings ? maybeQueue : bindingsOrQueue) || [];
                state.set(target, (...values: unknown[]) => {
                  if (settled) return;
                  const previousQueue = [...state.get(WI)];
                  if (hasBindings) {
                    for (let index = 0; index < bindingKeys.length; index++) {
                      state.set(bindingKeys[index], values[index]);
                    }
                  }
                  state.set(WI, [...queue]);
                  return runQueue()
                    .then(() => state.get(returnKey))
                    .catch((err) => String(err))
                    .finally(() => state.set(WI, previousQueue));
                });
              });

              try {
                state.set(WI, JSON.parse(xorDecode(atob(program), String(state.get(GI)))));
                runQueue().catch((err) => {
                  if (!settled) {
                    settled = true;
                    resolve(btoa(`${instructionCount}: ${err}`));
                  }
                });
              } catch (err) {
                if (!settled) {
                  settled = true;
                  resolve(btoa(`${instructionCount}: ${err}`));
                }
              }
            }),
        );

      installOpcodes();
      instructionCount = 0;
      state.set(GI, salt);
      return runVmProgram(dx);
    },
    { dx, salt: requirementsToken },
  );
}

function truncateForLog(value: string, maxLength = 500): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function isConversationCompletionPath(upstreamPath: string): boolean {
  return upstreamPath === '/backend-api/f/conversation';
}

function buildConversationPrepareBody(decodedBody: string | undefined): string | null {
  if (!decodedBody) return null;

  try {
    const parsed = JSON.parse(decodedBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const prepareBody = { ...parsed };
    delete prepareBody.messages;
    delete prepareBody.stream;
    return JSON.stringify(prepareBody);
  } catch {
    return null;
  }
}

async function fetchConversationConduitToken(
  page: Page,
  headers: Record<string, string>,
  decodedBody: string | undefined,
): Promise<string | null> {
  const prepareBody = buildConversationPrepareBody(decodedBody);
  if (!prepareBody) return null;

  const prepareHeaders = { ...headers };
  setHeader(prepareHeaders, 'Content-Type', 'application/json');
  if (!hasHeader(prepareHeaders, 'x-conduit-token')) {
    setHeader(prepareHeaders, 'x-conduit-token', 'no-token');
  }

  const result = await page.evaluate(
    async ({ hdrs, body }) => {
      try {
        const resp = await fetch('/backend-api/f/conversation/prepare', {
          method: 'POST',
          headers: hdrs,
          body,
          credentials: 'include' as RequestCredentials,
        });
        const text = await resp.text();
        let payload: any = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          // Keep payload null; caller logs status and body prefix.
        }
        return {
          status: resp.status,
          ok: resp.ok,
          conduitToken: typeof payload?.conduit_token === 'string' ? payload.conduit_token : '',
          bodyPrefix: text.slice(0, 300),
        };
      } catch (err: any) {
        return {
          status: 0,
          ok: false,
          conduitToken: '',
          bodyPrefix: err.message || String(err),
        };
      }
    },
    { hdrs: prepareHeaders, body: prepareBody },
  );

  if (result.ok && result.conduitToken) {
    return result.conduitToken;
  }

  console.warn(
    `[sidecar] Conversation prepare failed status=${result.status}: ${truncateForLog(result.bodyPrefix)}`,
  );
  return null;
}

async function ensureSentinelTokens(page: Page): Promise<boolean> {
  if (sentinelCache && Date.now() < sentinelCacheExpiresAt) {
    return true;
  }

  if (!sentinelRefreshPromise) {
    sentinelRefreshPromise = refreshSentinelTokens(page).finally(() => {
      sentinelRefreshPromise = null;
    });
  }

  return sentinelRefreshPromise;
}

function normalizeSSEChunk(state: StreamState, chunk: string): string {
  state.buffer += chunk;

  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() || '';

  let output = '';
  for (const line of lines) {
    output += normalizeSSELine(state, line);
  }

  return output;
}

function flushSSEStream(state: StreamState): string {
  let output = '';
  if (state.buffer.trim()) {
    output += normalizeSSELine(state, state.buffer);
    state.buffer = '';
  }
  if (!state.doneSent) {
    state.doneSent = true;
    output += 'data: [DONE]\n\n';
  }
  return output;
}

function normalizeSSELine(state: StreamState, line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    state.currentEvent = 'message';
    return '';
  }

  if (trimmed.startsWith('event:')) {
    state.currentEvent = trimmed.slice(6).trim() || 'message';
    return '';
  }
  if (!trimmed.startsWith('data:')) {
    return '';
  }

  const data = trimmed.slice(5).trim();
  if (!data) return '';
  if (data === '[DONE]') {
    // The browser callback owns finalization so it can recover a completed
    // assistant message when the handoff stream contains metadata only.
    return '';
  }
  if (state.currentEvent === 'error') {
    return `event: error\ndata: ${data}\n\n`;
  }
  if (state.currentEvent === 'delta_encoding') {
    const encoding = parseDeltaEncoding(data);
    if (encoding === 'v1') {
      state.deltaDecoder = new DeltaV1Decoder();
      return '';
    }
    return `event: error\ndata: Unsupported upstream delta encoding: ${encoding}\n\n`;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return '';
  }

  if (state.currentEvent === 'delta') {
    if (!state.deltaDecoder) {
      return 'event: error\ndata: Upstream delta event arrived before delta_encoding\n\n';
    }
    try {
      parsed = state.deltaDecoder.applyDelta(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `event: error\ndata: Failed to decode upstream delta: ${message}\n\n`;
    }
    if (!parsed) {
      return '';
    }
  }

  if (parsed?.error) {
    const message = typeof parsed.error === 'string'
      ? parsed.error
      : parsed.error.message || 'Upstream error';
    return `event: error\ndata: ${message}\n\n`;
  }

  const nextConversationId = extractConversationId(parsed);
  const conversationId = nextConversationId && nextConversationId !== state.conversationId
    ? nextConversationId
    : '';
  if (nextConversationId) {
    state.conversationId = nextConversationId;
  }
  const content = extractContentDelta(state, parsed);
  const progress = extractProgress(parsed);
  const reasoning = extractReasoning(parsed);
  const sources = extractSources(parsed);
  const imageGroups = extractImageGroups(parsed);
  const extractedImages = extractGeneratedImages(parsed);
  // Image-generation streams can expose glimpse/preview assets before the
  // async turn has finished. Only publish the turn-scoped final snapshot;
  // otherwise the UI can display a stale or replaceable image as final.
  const images = state.imageMode && state.currentEvent !== 'sidecar_final'
    ? []
    : state.currentEvent === 'sidecar_final'
      ? extractedImages
      : extractedImages.filter((item) => !state.imageIds.has(item.file_id));
  images.forEach((item) => state.imageIds.add(item.file_id));

  if (!conversationId && !content && images.length === 0 && !progress && !reasoning && sources.length === 0 && imageGroups.length === 0) {
    return '';
  }

  const normalized: Record<string, unknown> = {};
  if (conversationId) normalized.conversation_id = conversationId;
  if (content) normalized.content = content;
  const messageId = parsed?.message?.id || parsed?.id;
  if ((content || images.length > 0) && typeof messageId === 'string') normalized.message_id = messageId;
  if (progress) normalized.status = progress;
  if (reasoning) normalized.reasoning = reasoning;
  if (sources.length > 0) normalized.sources = sources;
  if (imageGroups.length > 0) normalized.image_groups = imageGroups;
  if (images.length > 0) normalized.images = images;

  return `data: ${JSON.stringify(normalized)}\n\n`;
}

function extractImageGroups(parsed: any): StreamImageGroup[] {
  if (Array.isArray(parsed?.image_groups)) {
    return parsed.image_groups.filter((group: any) =>
      typeof group?.matched_text === 'string' && Array.isArray(group?.images) && group.images.length > 0,
    );
  }
  const message = parsed?.message || parsed;
  const references = message?.metadata?.content_references;
  if (!Array.isArray(references)) return [];
  const groups: StreamImageGroup[] = [];
  for (const reference of references) {
    if (reference?.type !== 'image_group' || typeof reference?.matched_text !== 'string') continue;
    const images = Array.isArray(reference.images)
      ? reference.images.flatMap((item: any) => {
        const result = item?.image_result;
        if (typeof result?.thumbnail_url !== 'string' || typeof result?.content_url !== 'string') return [];
        return [{
          thumbnail_url: result.thumbnail_url,
          content_url: result.content_url,
          source_url: typeof result.url === 'string' ? result.url : undefined,
          title: typeof result.title === 'string' ? result.title : undefined,
          width: Number(result?.thumbnail_size?.width || 0) || undefined,
          height: Number(result?.thumbnail_size?.height || 0) || undefined,
        }];
      })
      : [];
    if (images.length > 0) {
      groups.push({
        matched_text: reference.matched_text,
        aspect_ratio: typeof reference.aspect_ratio === 'string' ? reference.aspect_ratio : undefined,
        images,
      });
    }
  }
  return groups;
}

function messageText(message: any): string {
  const parts = message?.content?.parts;
  if (Array.isArray(parts)) return parts.filter((part: unknown) => typeof part === 'string').join('\n');
  return typeof message?.content?.text === 'string' ? message.content.text : '';
}

function extractProgress(parsed: any): string {
  const message = parsed?.message || parsed;
  const text = messageText(message).trim();
  if (message?.metadata?.is_thinking_preamble_message === true && text) return text;
  if (message?.metadata?.search_queries || message?.metadata?.search_model_queries) return '正在搜索资料';
  if (message?.metadata?.search_result_groups) return '正在整理搜索结果';
  if (message?.content?.content_type === 'thoughts' && text) return text;
  return '';
}

function extractReasoning(parsed: any): string {
  const message = parsed?.message || parsed;
  const type = message?.content?.content_type;
  if (type !== 'reasoning_recap' && type !== 'thoughts') return '';
  return messageText(message).trim();
}

function extractSources(parsed: any): Array<{ id: string; title: string; url: string; domain?: string }> {
  const message = parsed?.message || parsed;
  const groups = message?.metadata?.search_result_groups;
  if (!Array.isArray(groups)) return [];
  const result: Array<{ id: string; title: string; url: string; domain?: string }> = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!Array.isArray(group?.entries)) continue;
    for (const entry of group.entries) {
      if (typeof entry?.url !== 'string' || seen.has(entry.url)) continue;
      seen.add(entry.url);
      result.push({ id: `source-${result.length + 1}`, title: entry.title || entry.url, url: entry.url, domain: group.domain || entry.attribution });
      if (result.length >= 12) return result;
    }
  }
  return result;
}

function extractConversationId(parsed: any): string {
  const candidates = [
    parsed?.conversation_id,
    parsed?.conversationId,
    parsed?.conversation?.id,
    parsed?.message?.conversation_id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  return '';
}

function extractContentDelta(state: StreamState, parsed: any): string {
  if (typeof parsed?.content === 'string') {
    state.lastContent += parsed.content;
    return parsed.content;
  }
  if (typeof parsed?.delta === 'string') {
    state.lastContent += parsed.delta;
    return parsed.delta;
  }

  const absolute = extractAbsoluteContent(parsed);
  if (!absolute) {
    return '';
  }

  if (absolute.startsWith(state.lastContent)) {
    const delta = absolute.slice(state.lastContent.length);
    state.lastContent = absolute;
    return delta;
  }

  if (absolute !== state.lastContent) {
    state.lastContent = absolute;
    return absolute;
  }

  return '';
}

function extractAbsoluteContent(parsed: any): string {
  const message = parsed?.message || parsed;
  const role = message?.author?.role;
  if (typeof role === 'string' && role !== 'assistant') {
    return '';
  }
  if (message?.metadata?.is_thinking_preamble_message === true) {
    return '';
  }
  if (message?.content?.content_type !== 'text') {
    return '';
  }

  const parts = message?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.filter((part) => typeof part === 'string').join('\n');
  }

  const text = message?.content?.text;
  if (typeof text === 'string') {
    return text;
  }

  return '';
}

function extractGeneratedImages(parsed: any): StreamImage[] {
  if (Array.isArray(parsed?.images)) {
    return parsed.images.filter((item: any) =>
      item && typeof item.file_id === 'string' && typeof item.download_url === 'string',
    );
  }
  const message = parsed?.message || parsed;
  if (message?.author?.role === 'user') return [];
  const parts = message?.content?.parts;
  if (!Array.isArray(parts)) return [];

  const images: StreamImage[] = [];
  const imagePartCount = parts.filter(
    (part: any) => part && typeof part === 'object' && part.content_type === 'image_asset_pointer',
  ).length;
  for (const part of parts) {
    if (!part || typeof part !== 'object' || part.content_type !== 'image_asset_pointer') continue;
    if (!part?.metadata?.generation && !part?.metadata?.dalle) continue;
    const pointer = typeof part.asset_pointer === 'string' ? part.asset_pointer : '';
    const fileId = pointer.replace(/^(?:sediment|file-service):\/\//, '');
    if (!fileId) continue;
    images.push({
      file_id: fileId,
      file_name: `${fileId}.png`,
      mime_type: typeof part.mime_type === 'string' ? part.mime_type : 'image/png',
      size_bytes: Number(part.size_bytes || 0),
      width: Number(part.width || 0),
      height: Number(part.height || 0),
      download_url: `/api/files/${encodeURIComponent(fileId)}/download`,
      generation_id: typeof part?.metadata?.generation?.gen_id === 'string'
        ? part.metadata.generation.gen_id
        : (typeof part?.metadata?.dalle?.gen_id === 'string' ? part.metadata.dalle.gen_id : undefined),
      message_id: typeof message?.id === 'string' ? message.id : undefined,
      candidate_group_message_id: imagePartCount > 1 && typeof message?.id === 'string' ? message.id : undefined,
    });
  }
  return images;
}

function parseDeltaEncoding(data: string): string {
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed === 'string') {
      return parsed;
    }
  } catch {
    // Fall through to the raw SSE payload for older unquoted encodings.
  }
  return data;
}

class DeltaV1Decoder {
  private previousByChannel: unknown[] = [];

  private previousDelta: ExpandedDeltaOperation = {
    channel: 0,
    path: '',
    op: 'add',
    value: undefined,
  };

  applyDelta(delta: unknown): unknown {
    if (!isPlainObject(delta)) {
      throw new Error('unexpected non-object delta');
    }

    const expanded = this.expandDelta(delta as DeltaOperation);
    const current = this.previousByChannel[expanded.channel];
    const next = applyJsonDelta(current, expanded);
    this.previousByChannel[expanded.channel] = next;
    return next;
  }

  private expandDelta(delta: DeltaOperation): ExpandedDeltaOperation {
    const withShortDefaults: DeltaOperation = { ...delta };
    if (withShortDefaults.c === undefined) withShortDefaults.c = this.previousDelta.channel;
    if (withShortDefaults.p === undefined) withShortDefaults.p = this.previousDelta.path;
    if (withShortDefaults.o === undefined) withShortDefaults.o = this.previousDelta.op;

    const expanded: ExpandedDeltaOperation = {
      channel: Number(withShortDefaults.c),
      path: String(withShortDefaults.p ?? ''),
      op: String(withShortDefaults.o ?? 'add'),
    };
    if ('v' in withShortDefaults) {
      expanded.value = expandDeltaValue(withShortDefaults.v);
    }

    this.previousDelta = expanded;
    return expanded;
  }
}

function expandDeltaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (isPlainObject(entry) && ('o' in entry || 'op' in entry)) {
        return expandPatchOperation(entry as DeltaOperation);
      }
      return entry;
    });
  }

  return value;
}

function expandPatchOperation(operation: DeltaOperation): ExpandedDeltaOperation {
  const expanded: ExpandedDeltaOperation = {
    channel: Number(operation.c ?? operation.channel ?? 0),
    path: String(operation.p ?? operation.path ?? ''),
    op: String(operation.o ?? operation.op ?? 'add'),
  };
  if ('v' in operation) {
    expanded.value = expandDeltaValue(operation.v);
  } else if ('value' in operation) {
    expanded.value = expandDeltaValue(operation.value);
  }
  return expanded;
}

function applyJsonDelta(root: unknown, delta: ExpandedDeltaOperation): unknown {
  const wrapper: Record<string, unknown> = { __root: root };
  applyJsonDeltaOperation(wrapper, delta);
  return wrapper.__root;
}

function applyJsonDeltaOperation(targetRoot: unknown, delta: ExpandedDeltaOperation): void {
  const pathParts = parseDeltaPath(delta.path);
  let target: any = targetRoot;

  for (let i = 0; i < pathParts.length - 1; i++) {
    const key = pathParts[i];
    const nextKey = pathParts[i + 1];
    if (target[key] === undefined) {
      target[key] = typeof nextKey === 'number' ? [] : {};
    }
    target = target[key];
  }

  const key = pathParts[pathParts.length - 1] as string | number;
  switch (delta.op) {
    case 'patch': {
      const operations = Array.isArray(delta.value) ? delta.value : [];
      for (const operation of operations) {
        if (!isExpandedDeltaOperation(operation)) continue;
        const nested: Record<string, unknown> = { __root: target[key] };
        applyJsonDeltaOperation(nested, operation);
        target[key] = nested.__root;
      }
      break;
    }
    case 'add':
      if (Array.isArray(target) && typeof key === 'number') {
        target.splice(key, 0, delta.value);
      } else {
        target[key] = delta.value;
      }
      break;
    case 'remove':
      if (Array.isArray(target) && typeof key === 'number') {
        target.splice(key, 1);
      } else {
        delete target[key];
      }
      break;
    case 'replace':
      target[key] = delta.value;
      break;
    case 'append':
      if (typeof target[key] === 'string') {
        target[key] += String(delta.value ?? '');
      } else if (Array.isArray(target[key])) {
        target[key].push(...ensureArray(delta.value));
      } else if (isPlainObject(target[key]) && isPlainObject(delta.value)) {
        Object.assign(target[key], delta.value);
      } else {
        target[key] = delta.value;
      }
      break;
    case 'truncate':
      if (typeof target[key] === 'string') {
        target[key] = target[key].substring(0, Number(delta.value));
      } else if (Array.isArray(target[key])) {
        target[key].length = Number(delta.value);
      }
      break;
    default:
      throw new Error(`unknown json delta operation: ${delta.op}`);
  }
}

function parseDeltaPath(pointer: string): Array<string | number> {
  const parts: Array<string | number> = ['__root'];
  if (!pointer) return parts;

  const normalized = pointer.startsWith('/') ? pointer.slice(1) : pointer;
  for (const part of normalized.split('/')) {
    if (/^(?:0|[1-9]\d*)$/.test(part)) {
      parts.push(Number(part));
    } else {
      parts.push(part.replace(/~1/g, '/').replace(/~0/g, '~'));
    }
  }
  return parts;
}

function ensureArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExpandedDeltaOperation(value: unknown): value is ExpandedDeltaOperation {
  return (
    isPlainObject(value) &&
    typeof value.channel === 'number' &&
    typeof value.path === 'string' &&
    typeof value.op === 'string'
  );
}

// refreshSentinelTokens executes the sentinel flow (prepare → PoW → finalize)
// inside the Chrome browser context and updates the module-level sentinelCache.
// Each page.evaluate() call is guarded by a hard 10s timeout to prevent indefinite hangs.
// Called once on startup and periodically via setInterval.
async function refreshSentinelTokens(page: Page): Promise<boolean> {
  const authorization = await getBrowserAuthorizationHeader(page);
  const requirementsToken = await generateRequirementsToken(page);

  // Step 1 — prepare (with 10s timeout)
  const prepResult = await withSentinelTimeout(
    page.evaluate(async ({ authHeader, proofSeed }) => {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (authHeader) headers.Authorization = authHeader;

        const resp = await fetch('/backend-api/sentinel/chat-requirements/prepare', {
          method: 'POST',
          headers,
          body: JSON.stringify({ p: proofSeed }),
          credentials: 'include' as RequestCredentials,
        });
        if (resp.headers.get('cf-mitigated') === 'challenge') {
          const body = await resp.text();
          return {
            error: `prepare Cloudflare challenge status ${resp.status}: ${body.slice(0, 500)}`,
            cfChallenge: true,
          };
        }
        if (!resp.ok) {
          const body = await resp.text();
          return { error: `prepare status ${resp.status}: ${body}` };
        }
        const data = await resp.json();
        return { data };
      } catch (err: any) {
        return { error: `prepare fetch failed: ${err.message || String(err)}` };
      }
    }, { authHeader: authorization, proofSeed: requirementsToken }),
    'prepare',
  );

  if ('error' in prepResult) {
    const message = prepResult.error || 'unknown prepare error';
    console.warn('[sidecar] Sentinel prepare failed:', truncateForLog(message));
    if ('cfChallenge' in prepResult && prepResult.cfChallenge) {
      await openCloudflareChallengePage(page, '/backend-api/sentinel/chat-requirements/prepare');
    }
    return false;
  }

  const prepData = prepResult.data as any;
  if (!prepData?.prepare_token) {
    console.warn('[sidecar] Sentinel prepare returned an unexpected payload:', prepData);
    return false;
  }

  // Step 2 — generate the same browser enforcement tokens used by chatgpt.com.
  const powStartedAt = Date.now();
  const [proofToken, turnstileToken] = await Promise.all([
    generateProofToken(page, prepData.proofofwork),
    generateTurnstileToken(page, prepData, requirementsToken),
  ]);

  if (prepData.proofofwork?.required && !proofToken) {
    console.warn('[sidecar] Sentinel PoW: failed to generate proof token');
    return false;
  }
  if (prepData.turnstile?.required && !turnstileToken) {
    console.warn('[sidecar] Sentinel Turnstile: failed to generate enforcement token');
    return false;
  }
  if (proofToken) {
    console.log(`[sidecar] Sentinel PoW solved in ${Date.now() - powStartedAt}ms`);
  }

  // Step 3 — finalize (with 10s timeout)
  const finalizeBody: any = {
    prepare_token: prepData.prepare_token,
  };
  if (proofToken) {
    finalizeBody.proofofwork = proofToken;
  }
  if (turnstileToken) {
    finalizeBody.turnstile = turnstileToken;
  }

  const finResult = await withSentinelTimeout(
    page.evaluate(async ({ finBody, authHeader }) => {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (authHeader) headers.Authorization = authHeader;

        const resp = await fetch('/backend-api/sentinel/chat-requirements/finalize', {
          method: 'POST',
          headers,
          body: JSON.stringify(finBody),
          credentials: 'include' as RequestCredentials,
        });
        if (resp.headers.get('cf-mitigated') === 'challenge') {
          const body = await resp.text();
          return {
            error: `finalize Cloudflare challenge status ${resp.status}: ${body.slice(0, 500)}`,
            cfChallenge: true,
          };
        }
        if (!resp.ok) {
          const body = await resp.text();
          return { error: `finalize status ${resp.status}: ${body}` };
        }
        const data = await resp.json();
        return { data };
      } catch (err: any) {
        return { error: `finalize fetch failed: ${err.message || String(err)}` };
      }
    }, { finBody: finalizeBody, authHeader: authorization }),
    'finalize',
  );

  if ('error' in finResult) {
    const message = finResult.error || 'unknown finalize error';
    console.warn('[sidecar] Sentinel finalize failed:', truncateForLog(message));
    if ('cfChallenge' in finResult && finResult.cfChallenge) {
      await openCloudflareChallengePage(page, '/backend-api/sentinel/chat-requirements/finalize');
    }
    return false;
  }

  const finData = finResult.data as any;
  const chatRequirementsToken = typeof finData?.token === 'string' ? finData.token : '';
  if (!chatRequirementsToken) {
    console.warn('[sidecar] Sentinel finalize returned no chat requirements token:', finData);
    return false;
  }

  sentinelCache = {
    'OpenAI-Sentinel-Chat-Requirements-Token': chatRequirementsToken,
  };
  if (proofToken) {
    sentinelCache['OpenAI-Sentinel-Proof-Token'] = proofToken;
  }
  if (turnstileToken) {
    sentinelCache['OpenAI-Sentinel-Turnstile-Token'] = turnstileToken;
  }
  sentinelCacheExpiresAt = Date.now() + SENTINEL_CACHE_TTL_MS;

  console.log('[sidecar] Sentinel tokens fetched and cached successfully');
  return true;
}

// ---- Proxy Handlers ----

interface ProxyRequestBody {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Non-streaming proxy: uses page.evaluate()+fetch() to send the request from
 *  the browser page context (same pattern as handleStreamProxy and checkLoginStatus).
 *  page.route()+route.fetch() was tried but Cloudflare silently drops CDP-intercepted
 *  requests (TCP timeout, no HTTP response). */
async function handleNonStreamProxy(
  page: Page,
  method: string,
  upstreamPath: string,
  headers: Record<string, string>,
  body: string | undefined,
  res: Response,
): Promise<void> {
  const isExternalUrl = /^https?:\/\//i.test(upstreamPath);
  // ChatGPT requests use the current Chrome session. Signed storage URLs carry
  // their own credentials and must not receive the ChatGPT bearer token.
  if (isExternalUrl) {
    deleteHeader(headers, 'authorization');
  } else {
    await applyBrowserAuthHeaders(page, headers);
  }

  // Decode base64-encoded body from Go before passing to browser fetch()
  const decodedBody = body ? Buffer.from(body, 'base64').toString('utf-8') : undefined;

  // Conversation requests require fresh sentinel headers on many ChatGPT sessions.
  if (isConversationCompletionPath(upstreamPath)) {
    setHeader(headers, 'accept', 'text/event-stream');
    if (!hasHeader(headers, 'x-oai-turn-trace-id')) {
      setHeader(headers, 'x-oai-turn-trace-id', randomUUID());
    }
    const conduitToken = await fetchConversationConduitToken(page, headers, decodedBody);
    if (conduitToken) {
      setHeader(headers, 'x-conduit-token', conduitToken);
    }

    let sentinelReady = false;
    try {
      sentinelReady = await refreshSentinelTokens(page);
    } catch (err) {
      console.warn('[sidecar] Sentinel refresh before non-stream conversation failed:', err);
    }
    const tokens = fetchSentinelTokens();
    if (sentinelReady && tokens) {
      Object.assign(headers, tokens);
    } else {
      console.warn('[sidecar] Blocking non-stream conversation because sentinel tokens are unavailable.');
      const body = Buffer.from(
        JSON.stringify({
          error: 'Cloudflare verification is required before sending messages. Complete the challenge in the sidecar Chrome window and retry.',
        }),
      ).toString('base64');
      res.json({
        status: 403,
        headers: { 'content-type': 'application/json' },
        body,
      });
      return;
    }
  }

  const targetUrl = upstreamPath;

  // Execute fetch() inside the browser page context so the request uses Chrome's
  // cookies, TLS fingerprint, and HTTP/2 settings — same pattern as handleStreamProxy
  // and checkLoginStatus (CSP bypass is already enabled via CDP).
  const result = await page.evaluate(
    async ({ url, method: m, headers: hdrs, bodyBase64 }) => {
      try {
        const bytesToBase64 = (bytes: Uint8Array): string => {
          let binary = '';
          const chunkSize = 0x8000;
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
            binary += String.fromCharCode(...chunk);
          }
          return btoa(binary);
        };
        const fetchOptions: RequestInit = {
          method: m || 'POST',
          headers: hdrs || {},
          credentials: 'include' as RequestCredentials,
        };
        if (bodyBase64 && m !== 'GET' && m !== 'HEAD') {
          const binary = atob(bodyBase64);
          const requestBytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index++) {
            requestBytes[index] = binary.charCodeAt(index);
          }
          fetchOptions.body = requestBytes;
        }
        const resp = await fetch(url, fetchOptions);

        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((value: string, key: string) => {
          respHeaders[key] = value;
        });

        if (resp.headers.get('cf-mitigated') === 'challenge') {
          const challengeBody = JSON.stringify({
            error: 'Cloudflare challenge encountered. The sidecar opened the challenge URL in Chrome; complete it there and retry.',
          });
          return {
            status: 403,
            headers: { ...respHeaders, 'content-type': 'application/json' },
            body: bytesToBase64(new TextEncoder().encode(challengeBody)),
            cfChallenge: true,
          };
        }

        const respBody = new Uint8Array(await resp.arrayBuffer());

        return {
          status: resp.status,
          headers: respHeaders,
          body: bytesToBase64(respBody),
          cfChallenge: false,
        };
      } catch (err: any) {
        const message = err.message || String(err);
        return {
          status: 0,
          headers: {} as Record<string, string>,
          body: '',
          error: `Browser fetch failed before receiving an HTTP response: ${message}. If Chrome shows net::ERR_CONNECTION_CLOSED, complete any Cloudflare challenge in the sidecar Chrome window and retry.`,
          cfChallenge: false,
        };
      }
    },
    { url: targetUrl, method, headers, bodyBase64: body },
  );

  if (result.cfChallenge) {
    await openCloudflareChallengePage(page, upstreamPath);
  }
  if (result.status === 0 && result.error) {
    console.warn(`[sidecar] Non-stream browser fetch failed for ${upstreamPath}: ${result.error}`);
  }
  if (result.status === 401) {
    clearBrowserAuthCache();
  }

  const { cfChallenge: _cfChallenge, ...responsePayload } = result;
  res.json(responsePayload);
}

/** Raw binary proxy: streams response bytes from the browser to Node in
 * bounded base64 chunks. The exposed callback awaits Node's drain event, so
 * backpressure propagates all the way to the browser ReadableStream. */
async function handleRawStreamProxy(
  page: Page,
  method: string,
  upstreamPath: string,
  headers: Record<string, string>,
  body: string | undefined,
  req: Request,
  res: Response,
): Promise<void> {
  const streamId = randomUUID();
  const isExternalUrl = /^https?:\/\//i.test(upstreamPath);
  if (isExternalUrl) {
    deleteHeader(headers, 'authorization');
  } else {
    await applyBrowserAuthHeaders(page, headers);
  }

  activeRawStreams.set(streamId, { res });
  res.once('close', () => deleteActiveRawStream(streamId));

  try {
    const result = await page.evaluate(
      async ({ streamId: id, url, method: requestMethod, headers: requestHeaders, bodyBase64 }) => {
        const callback = (window as any).__sidecarRawStreamEvent as (
          streamId: string,
          event: { type: string; status?: number; headers?: Record<string, string>; chunk?: string; error?: string },
        ) => Promise<boolean>;
        const bytesToBase64 = (bytes: Uint8Array): string => {
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            const chunk = bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length));
            binary += String.fromCharCode(...chunk);
          }
          return btoa(binary);
        };
        try {
          const options: RequestInit = {
            method: requestMethod || 'GET',
            headers: requestHeaders || {},
            credentials: 'include' as RequestCredentials,
          };
          if (bodyBase64 && requestMethod !== 'GET' && requestMethod !== 'HEAD') {
            const binary = atob(bodyBase64);
            const requestBytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index++) requestBytes[index] = binary.charCodeAt(index);
            options.body = requestBytes;
          }
          const response = await fetch(url, options);
          const responseHeaders: Record<string, string> = {};
          response.headers.forEach((value, key) => { responseHeaders[key] = value; });
          const cfChallenge = response.headers.get('cf-mitigated') === 'challenge';
          if (!await callback(id, { type: 'start', status: response.status, headers: responseHeaders })) {
            await response.body?.cancel();
            return { cfChallenge };
          }
          const reader = response.body?.getReader();
          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              for (let offset = 0; offset < value.length; offset += 64 * 1024) {
                const chunk = value.subarray(offset, Math.min(offset + 64 * 1024, value.length));
                if (!await callback(id, { type: 'chunk', chunk: bytesToBase64(chunk) })) {
                  await reader.cancel();
                  return { cfChallenge };
                }
              }
            }
          }
          await callback(id, { type: 'done' });
          return { cfChallenge };
        } catch (error: any) {
          await callback(id, { type: 'error', error: error?.message || String(error) });
          return { cfChallenge: false };
        }
      },
      { streamId, url: upstreamPath, method, headers, bodyBase64: body },
    );
    if (result.cfChallenge) await openCloudflareChallengePage(page, upstreamPath);
  } catch (error) {
    const state = activeRawStreams.get(streamId);
    if (state && !state.res.destroyed && !state.res.writableEnded) {
      if (!state.res.headersSent) {
        state.res.status(502).json({ error: 'Raw stream failed', detail: String(error) });
      } else {
        state.res.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
    deleteActiveRawStream(streamId);
  }
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

  // Ignore caller-supplied auth and use the access token from this Chrome session.
  await applyBrowserAuthHeaders(page, headers);

  // Decode base64-encoded body from Go before passing to browser fetch()
  const decodedBody = body ? Buffer.from(body, 'base64').toString('utf-8') : undefined;

  // Conversation requests require fresh sentinel headers on many ChatGPT sessions.
  if (isConversationCompletionPath(upstreamPath)) {
    setHeader(headers, 'accept', 'text/event-stream');
    if (!hasHeader(headers, 'x-oai-turn-trace-id')) {
      setHeader(headers, 'x-oai-turn-trace-id', randomUUID());
    }
    const conduitToken = await fetchConversationConduitToken(page, headers, decodedBody);
    if (conduitToken) {
      setHeader(headers, 'x-conduit-token', conduitToken);
    }

    let sentinelReady = false;
    try {
      sentinelReady = await refreshSentinelTokens(page);
    } catch (err) {
      console.warn('[sidecar] Sentinel refresh before stream conversation failed:', err);
    }
    const tokens = fetchSentinelTokens();
    if (sentinelReady && tokens) {
      Object.assign(headers, tokens);
    } else {
      console.warn('[sidecar] Blocking stream conversation because sentinel tokens are unavailable.');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(
        'event: error\ndata: Cloudflare verification is required before sending messages. Complete the challenge in the sidecar Chrome window and retry.\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
  }

  // Write SSE response headers immediately
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const heartbeat = setInterval(() => {
    const state = activeStreams.get(streamId);
    if (!state || state.res.writableEnded) {
      deleteActiveStream(streamId);
      return;
    }
    state.res.write(': heartbeat\n\n');
  }, 15_000);

  activeStreams.set(streamId, {
    res,
    heartbeat,
    buffer: '',
    lastContent: '',
    conversationId: '',
    doneSent: false,
    currentEvent: 'message',
    deltaDecoder: null,
    imageIds: new Set<string>(),
    imageMode: decodedBody?.includes('"picture_v2"') ?? false,
  });

  // IncomingMessage "close" can fire after the request body completes even
  // while the streaming response is still active. Only response closure means
  // the downstream client has gone away.
  res.once('close', () => {
    deleteActiveStream(streamId);
  });

  // Fire-and-forget: the browser evaluate runs in the background and calls
  // __sidecarStreamChunk for each chunk.
  page
    .evaluate(
      async ({ method, path: p, headers: hdrs, body: b, streamId: sid, imageMode }) => {
        const win = window as any;
        // page.evaluate runs in the browser realm and cannot close over helper
        // functions declared in the Node/sidecar realm. Keep final-snapshot
        // parsing self-contained so a completed upstream generation is never
        // turned into a local ReferenceError.
        const browserMessageText = (message: any): string => {
          const parts = message?.content?.parts;
          if (Array.isArray(parts)) {
            return parts.filter((part: unknown) => typeof part === 'string').join('\n');
          }
          return typeof message?.content?.text === 'string' ? message.content.text : '';
        };
        const browserExtractSources = (message: any): Array<{ id: string; title: string; url: string; domain?: string }> => {
          const groups = message?.metadata?.search_result_groups;
          if (!Array.isArray(groups)) return [];
          const result: Array<{ id: string; title: string; url: string; domain?: string }> = [];
          const seen = new Set<string>();
          for (const group of groups) {
            if (!Array.isArray(group?.entries)) continue;
            for (const entry of group.entries) {
              try {
                if (typeof entry?.url !== 'string' || seen.has(entry.url)) continue;
                seen.add(entry.url);
                result.push({
                  id: `source-${result.length + 1}`,
                  title: typeof entry.title === 'string' && entry.title ? entry.title : entry.url,
                  url: entry.url,
                  domain: typeof group.domain === 'string' ? group.domain : entry.attribution,
                });
                if (result.length >= 12) return result;
              } catch {
                // A malformed source must not discard an otherwise complete response.
              }
            }
          }
          return result;
        };
        const browserExtractImageGroups = (message: any): StreamImageGroup[] => {
          const references = message?.metadata?.content_references;
          if (!Array.isArray(references)) return [];
          return references.flatMap((reference: any) => {
            if (reference?.type !== 'image_group' || typeof reference?.matched_text !== 'string' || !Array.isArray(reference?.images)) return [];
            const images = reference.images.flatMap((item: any) => {
              const result = item?.image_result;
              if (typeof result?.thumbnail_url !== 'string' || typeof result?.content_url !== 'string') return [];
              return [{
                thumbnail_url: result.thumbnail_url,
                content_url: result.content_url,
                source_url: typeof result.url === 'string' ? result.url : undefined,
                title: typeof result.title === 'string' ? result.title : undefined,
                width: Number(result?.thumbnail_size?.width || 0) || undefined,
                height: Number(result?.thumbnail_size?.height || 0) || undefined,
              }];
            });
            return images.length > 0 ? [{ matched_text: reference.matched_text, aspect_ratio: reference.aspect_ratio, images }] : [];
          });
        };
        try {
          const url = p;
          const fetchOptions: RequestInit = {
            method: method || 'POST',
            headers: hdrs || {},
            credentials: 'include' as RequestCredentials,
          };
          if (b !== undefined && b !== null && method !== 'GET' && method !== 'HEAD') {
            fetchOptions.body = b;
          }

          const resp = await fetch(url, fetchOptions);

          if (resp.headers.get('cf-mitigated') === 'challenge') {
            await win.__sidecarStreamChunk(
              sid,
              'event: error\ndata: Cloudflare challenge encountered. The sidecar opened the challenge URL in Chrome; complete it there and retry.\n\n',
              true,
            );
            return { status: 403, cfChallenge: true };
          }

          if (!resp.ok) {
            const errorBody = await resp.text();
            let errorMessage = `HTTP ${resp.status}: ${errorBody}`;
            try {
              const parsed = JSON.parse(errorBody);
              if (typeof parsed?.detail === 'string') {
                errorMessage = `HTTP ${resp.status}: ${parsed.detail}`;
              } else if (typeof parsed?.error === 'string') {
                errorMessage = `HTTP ${resp.status}: ${parsed.error}`;
              }
            } catch {
              // Keep the raw upstream body when it is not JSON.
            }
            await win.__sidecarStreamChunk(
              sid,
              `event: error\ndata: ${errorMessage}\n\n`,
              true,
            );
            return { status: resp.status, cfChallenge: false };
          }

          if (!resp.body) {
            await win.__sidecarStreamChunk(
              sid,
              'event: error\ndata: No response body\n\n',
              true,
            );
            return { status: resp.status, cfChallenge: false };
          }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          const initialChunks: string[] = [];
          const shouldHandleHandoff = p === '/backend-api/f/conversation';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (!text) continue;
            if (shouldHandleHandoff) {
              initialChunks.push(text);
            } else {
              await win.__sidecarStreamChunk(sid, text, false);
            }
          }

          // Flush any remaining bytes
          const remaining = decoder.decode();
          if (remaining) {
            if (shouldHandleHandoff) {
              initialChunks.push(remaining);
            } else {
              await win.__sidecarStreamChunk(sid, remaining, false);
            }
          }

          if (shouldHandleHandoff) {
            const initialText = initialChunks.join('');
            const handoff = (() => {
              let currentEvent = 'message';
              let dataLines: string[] = [];
              let resumeToken = '';
              let conversationId = '';

              const consume = () => {
                if (dataLines.length === 0) return;
                const data = dataLines.join('\n').trim();
                dataLines = [];
                if (!data || data === '[DONE]') return;
                try {
                  const parsed = JSON.parse(data);
                  if (typeof parsed?.conversation_id === 'string') {
                    conversationId = parsed.conversation_id;
                  }
                  if (
                    parsed?.type === 'resume_conversation_token' &&
                    typeof parsed?.token === 'string'
                  ) {
                    resumeToken = parsed.token;
                  }
                } catch {
                  // Ignore non-JSON SSE payloads while looking for handoff metadata.
                }
              };

              for (const rawLine of initialText.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line) {
                  consume();
                  currentEvent = 'message';
                  continue;
                }
                if (line.startsWith('event:')) {
                  currentEvent = line.slice(6).trim() || 'message';
                  continue;
                }
                if (line.startsWith('data:')) {
                  dataLines.push(line.slice(5).trim());
                }
              }
              consume();

              return resumeToken && conversationId ? { resumeToken, conversationId } : null;
            })();

            if (handoff) {
              const initialWithoutDone = initialText.replace(/\r?\ndata:\s*\[DONE\]\s*\r?\n\r?\n/g, '\n');
              if (initialWithoutDone.trim()) {
                await win.__sidecarStreamChunk(sid, initialWithoutDone, false);
              }

              const resumeHeaders: Record<string, string> = {
                ...(hdrs || {}),
                'Content-Type': 'application/json',
                accept: 'text/event-stream',
                'x-conduit-token': handoff.resumeToken,
              };
              const resumeResp = await fetch('/backend-api/f/conversation/resume', {
                method: 'POST',
                headers: resumeHeaders,
                body: JSON.stringify({ conversation_id: handoff.conversationId, offset: 0 }),
                credentials: 'include' as RequestCredentials,
              });

              if (!resumeResp.ok) {
                const errorBody = await resumeResp.text();
                await win.__sidecarStreamChunk(
                  sid,
                  `event: error\ndata: Resume HTTP ${resumeResp.status}: ${errorBody}\n\n`,
                  true,
                );
                return { status: resumeResp.status, cfChallenge: false };
              }
              if (!resumeResp.body) {
                await win.__sidecarStreamChunk(sid, 'event: error\ndata: No resume body\n\n', true);
                return { status: resumeResp.status, cfChallenge: false };
              }

              const resumeReader = resumeResp.body.getReader();
              const resumeDecoder = new TextDecoder();
              while (true) {
                const { done, value } = await resumeReader.read();
                if (done) break;
                const text = resumeDecoder.decode(value, { stream: true });
                if (text) await win.__sidecarStreamChunk(sid, text, false);
              }
              const resumeRemaining = resumeDecoder.decode();
              if (resumeRemaining) await win.__sidecarStreamChunk(sid, resumeRemaining, false);

              // The handoff stream can contain only control metadata for image
              // generation. Read the finalized conversation in the same page
              // context and emit a normalized final snapshot.
              let finalSnapshotSent = false;
              let lastAsyncStatusError = '';
              let lastDetailError = '';
              const maxPollAttempts = imageMode ? 165 : 30;
              for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
                const authEntry = Object.entries(hdrs || {}).find(
                  ([key]) => key.toLowerCase() === 'authorization',
                );
                const detailHeaders: Record<string, string> = {};
                if (authEntry) detailHeaders.Authorization = authEntry[1];
                if (imageMode) {
                  const asyncResp = await fetch(
                    `/backend-api/conversation/${encodeURIComponent(handoff.conversationId)}/async-status`,
                    {
                      method: 'POST',
                      headers: detailHeaders,
                      body: '{}',
                      credentials: 'include' as RequestCredentials,
                    },
                  );
                  const asyncBody = await asyncResp.text().catch(() => '');
                  if (!asyncResp.ok) {
                    lastAsyncStatusError = `HTTP ${asyncResp.status}${asyncBody ? `: ${asyncBody.slice(0, 200)}` : ''}`;
                  } else {
                    try {
                      const asyncPayload = JSON.parse(asyncBody);
                      lastAsyncStatusError = asyncPayload?.status === 'OK'
                        ? ''
                        : `unexpected response: ${asyncBody.slice(0, 200)}`;
                    } catch {
                      lastAsyncStatusError = `invalid JSON response: ${asyncBody.slice(0, 200)}`;
                    }
                  }
                }
                const detailResp = await fetch(
                  `/backend-api/conversation/${encodeURIComponent(handoff.conversationId)}`,
                  {
                    method: 'GET',
                    headers: detailHeaders,
                    credentials: 'include' as RequestCredentials,
                    cache: 'no-store' as RequestCache,
                  },
                );
                if (detailResp.ok) {
                  const conversation = await detailResp.json();
                  const messages: any[] = Object.values(conversation?.mapping || {})
                    .map((node: any) => node?.message)
                    .filter(Boolean);
                  const byCreateTime = (left: any, right: any) =>
                    Number(left?.create_time || 0) - Number(right?.create_time || 0);
                  const latestUserMessage = messages
                    .filter((message: any) => message?.author?.role === 'user')
                    .sort(byCreateTime)
                    .at(-1);
                  const currentTurnId = latestUserMessage?.metadata?.working_turn_id
                    || latestUserMessage?.metadata?.turn_exchange_id;
                  const currentTurnMessages = currentTurnId
                    ? messages.filter((message: any) =>
                      message?.metadata?.working_turn_id === currentTurnId
                      || message?.metadata?.turn_exchange_id === currentTurnId,
                    )
                    : messages.filter((message: any) =>
                      Number(message?.create_time || 0) >= Number(latestUserMessage?.create_time || 0),
                    );
                  const textMessages = currentTurnMessages
                    .filter((message: any) =>
                      message?.author?.role === 'assistant' &&
                      message?.content?.content_type === 'text' &&
                      message?.metadata?.is_thinking_preamble_message !== true,
                    )
                    .sort(byCreateTime);
                  const latestText = textMessages.at(-1)?.content?.parts;
                  const content = Array.isArray(latestText)
                    ? latestText.filter((part: unknown) => typeof part === 'string').join('\n')
                    : '';
                  const latestTextMessage = textMessages.at(-1);
                  const sources = browserExtractSources(latestTextMessage || {});
                  const imageGroups = browserExtractImageGroups(latestTextMessage || {});
                  const reasoningMessages = currentTurnMessages
                    .filter((message: any) => message?.author?.role === 'assistant' && ['thoughts', 'reasoning_recap'].includes(message?.content?.content_type))
                    .sort(byCreateTime);
                  const reasoning = reasoningMessages.map((message: any) => browserMessageText(message)).filter(Boolean).at(-1) || '';
                  const imageById = new Map<string, StreamImage>();
                  const candidateGroupByFile = new Map<string, string>();
                  const candidateMessageByFile = new Map<string, string>();
                  const finalImageMessages = currentTurnMessages.filter((message: any) =>
                    message?.author?.role !== 'user'
                    && message?.status === 'finished_successfully'
                    && message?.metadata?.ghostrider?.status === 'final'
                    && Array.isArray(message?.content?.parts)
                    && message.content.parts.some((part: any) =>
                      part?.content_type === 'image_asset_pointer'
                      && (part?.metadata?.generation || part?.metadata?.dalle),
                    ),
                  );
                  for (const message of finalImageMessages) {
                    const imageParts = message.content.parts.filter(
                      (part: any) => part?.content_type === 'image_asset_pointer'
                        && (part?.metadata?.generation || part?.metadata?.dalle),
                    );
                    for (const part of message.content.parts) {
                      if (part?.content_type !== 'image_asset_pointer') continue;
                      if (!part?.metadata?.generation && !part?.metadata?.dalle) continue;
                      const pointer = typeof part.asset_pointer === 'string' ? part.asset_pointer : '';
                      const fileId = pointer.replace(/^(?:sediment|file-service):\/\//, '');
                      if (!fileId) continue;
                      if (imageParts.length > 1 && typeof message?.id === 'string') {
                        candidateGroupByFile.set(fileId, message.id);
                      } else if (imageParts.length === 1 && typeof message?.id === 'string') {
                        candidateMessageByFile.set(fileId, message.id);
                      }
                      if (imageById.has(fileId)) continue;
                      imageById.set(fileId, {
                        file_id: fileId,
                        file_name: `${fileId}.png`,
                        mime_type: typeof part.mime_type === 'string' ? part.mime_type : 'image/png',
                        size_bytes: Number(part.size_bytes || 0),
                        width: Number(part.width || 0),
                        height: Number(part.height || 0),
                        download_url: `/api/files/${encodeURIComponent(fileId)}/download`,
                        generation_id: typeof part?.metadata?.generation?.gen_id === 'string'
                          ? part.metadata.generation.gen_id
                          : (typeof part?.metadata?.dalle?.gen_id === 'string'
                            ? part.metadata.dalle.gen_id
                            : undefined),
                      });
                    }
                  }
                  const images = Array.from(imageById.values()).map((image) => ({
                    ...image,
                    message_id: candidateMessageByFile.get(image.file_id) || image.message_id,
                    candidate_group_message_id: candidateGroupByFile.get(image.file_id),
                  }));
                  const imageReady = imageMode && finalImageMessages.length > 0 && images.length > 0;
                  const textReady = !imageMode && content.length > 0;
                  if (textReady || imageReady) {
                    await win.__sidecarStreamChunk(
                      sid,
                      `event: sidecar_final\ndata: ${JSON.stringify({ content, images, image_groups: imageGroups, reasoning, sources, message_id: latestTextMessage?.id })}\n\n`,
                      false,
                    );
                    finalSnapshotSent = true;
                    break;
                  }
                  lastDetailError = '';
                } else {
                  lastDetailError = `HTTP ${detailResp.status}: ${(await detailResp.text().catch(() => '')).slice(0, 200)}`;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
              if (!finalSnapshotSent) {
                const details = [
                  lastAsyncStatusError && `async-status ${lastAsyncStatusError}`,
                  lastDetailError && `conversation detail ${lastDetailError}`,
                ].filter(Boolean).join('; ');
                await win.__sidecarStreamChunk(
                  sid,
                  `event: error\ndata: ${imageMode ? 'Timed out waiting for the current image generation to finish' : 'Timed out waiting for the completed response'}${details ? `: ${details}` : ''}\n\n`,
                  false,
                );
              }
            } else if (initialText) {
              await win.__sidecarStreamChunk(sid, initialText, false);
            }
          }

          // Signal completion
          await win.__sidecarStreamChunk(sid, '', true);
          return { status: resp.status, cfChallenge: false };
        } catch (err: any) {
          const message = err.message || 'Unknown error';
          await win.__sidecarStreamChunk(
            sid,
            `event: error\ndata: Browser fetch failed before receiving an HTTP response: ${message}. If Chrome shows net::ERR_CONNECTION_CLOSED, complete any Cloudflare challenge in the sidecar Chrome window and retry.\n\n`,
            true,
          );
          return { status: 0, cfChallenge: false, error: message };
        }
      },
      {
        method,
        path: upstreamPath,
        headers,
        body: decodedBody,
        streamId,
        imageMode: decodedBody?.includes('"picture_v2"') ?? false,
      },
    )
    .then((result) => {
      if (result?.cfChallenge) {
        void openCloudflareChallengePage(page, upstreamPath);
      }
      if (result?.status === 401) {
        clearBrowserAuthCache();
      }
      if (result?.error) {
        console.warn(`[sidecar] Stream browser fetch failed for ${upstreamPath}: ${result.error}`);
      }
    })
    .catch((err) => {
      console.error('[sidecar] Stream evaluate rejected:', err);
      const state = activeStreams.get(streamId);
      if (state && !state.res.writableEnded) {
        state.res.write(`event: error\ndata: ${err.message}\n\ndata: [DONE]\n\n`);
        state.res.end();
        deleteActiveStream(streamId);
      }
    });
}

// ---- Express Server ----

function startServer(): void {
  const app = express();

  // Parse JSON bodies — the outer envelope is JSON; the inner "body" field
  // is a pre-serialized string that we pass through untouched.
  // Base64 adds roughly 33% overhead to the 50 MB upload limit.
  app.use(express.json({ limit: '70mb' }));

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
      if (isReady && !proxyPage) {
        reportBrowserUnavailable('Proxy page is missing; recovery is starting.');
      }
      const recovered = await recoveryController?.ensureReady(
        'Proxy request arrived while the browser was unavailable.',
        BROWSER_RECOVERY_WAIT_MS,
      );
      if (!recovered || !isReady || !proxyPage) {
        res.setHeader('Retry-After', '5');
        res.status(503).json({ error: readyError || 'Sidecar browser recovery is still in progress' });
        return;
      }
    }

    const page = proxyPage;

    const streamMode = typeof req.query.stream === 'string' ? req.query.stream : '';
    const { method, path: upstreamPath, headers, body } = req.body as ProxyRequestBody;

    if (!upstreamPath) {
      res.status(400).json({ error: 'Missing "path" field in request body' });
      return;
    }

    try {
      if (streamMode === 'true') {
        await handleStreamProxy(
          page,
          method || 'POST',
          upstreamPath,
          headers || {},
          body,
          req,
          res,
        );
      } else if (streamMode === 'raw') {
        await handleRawStreamProxy(
          page,
          method || 'GET',
          upstreamPath,
          headers || {},
          body,
          req,
          res,
        );
      } else {
        await handleNonStreamProxy(
          page,
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
  console.log(`[sidecar] Browser launch mode: ${CHROME_LAUNCH_MODE}`);
  console.log(`[sidecar] Chrome login mode: ${CHROME_LOGIN_MODE}`);
  if (CHROME_LAUNCH_MODE === 'cdp') {
    console.log(`[sidecar] Chrome CDP endpoint: 127.0.0.1:${CHROME_CDP_PORT}`);
    console.log(
      CHROME_EXECUTABLE_PATH
        ? `[sidecar] Browser executable: ${CHROME_EXECUTABLE_PATH}`
        : '[sidecar] Browser executable: auto-detect Chrome Stable',
    );
  } else {
    console.log(
      CHROME_EXECUTABLE_PATH
        ? `[sidecar] Browser executable: ${CHROME_EXECUTABLE_PATH}`
        : `[sidecar] Browser channel: ${CHROME_CHANNEL || 'playwright-default'}`,
    );
  }

  recoveryController = new BrowserRecoveryController({
    recover: recoverBrowser,
    isReady: () => isReady && Boolean(proxyPage),
    onAttempt: ({ attempt, reason }) => {
      readyError = `Browser recovery attempt ${attempt}: ${reason}`;
      console.log(`[sidecar] ${readyError}`);
    },
    onFailure: ({ attempt, error }) => {
      readyError = `Browser recovery attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`;
      console.warn(`[sidecar] ${readyError}`);
    },
    onRecovered: ({ attempt }) => {
      readyError = null;
      console.log(`[sidecar] Browser recovery succeeded on attempt ${attempt}.`);
    },
  });

  try {
    await initializeBrowser();
  } catch (err) {
    console.error('[sidecar] Browser initialization failed:', err);
    readyError = String(err);
    // Start the server anyway — /health will report unhealthy.
  }

  startServer();
  startBrowserWatchdog();
  if (!isReady) {
    void recoveryController.request(readyError || 'Initial browser setup did not complete.');
  }
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log('[sidecar] Shutting down...');
  shuttingDown = true;
  recoveryController?.stop();
  recoveryController = null;
  if (browserWatchdogTimer) {
    clearInterval(browserWatchdogTimer);
    browserWatchdogTimer = null;
  }
  if (sentinelRefreshTimer) {
    clearInterval(sentinelRefreshTimer);
    sentinelRefreshTimer = null;
  }
  failActiveStreams('Sidecar is shutting down.');
  failActiveRawStreams('Sidecar is shutting down.');
  await resetBrowserSession();
}

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});

main().catch((err) => {
  console.error('[sidecar] Fatal error:', err);
  process.exit(1);
});
