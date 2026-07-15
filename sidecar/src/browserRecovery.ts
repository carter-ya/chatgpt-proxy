export interface RecoveryAttempt {
  attempt: number;
  reason: string;
}

interface BrowserRecoveryOptions {
  recover: () => Promise<void>;
  isReady: () => boolean;
  delaysMs?: number[];
  onAttempt?: (state: RecoveryAttempt) => void;
  onFailure?: (state: RecoveryAttempt & { error: unknown }) => void;
  onRecovered?: (state: RecoveryAttempt) => void;
}

const DEFAULT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export class BrowserRecoveryController {
  private readonly recover: () => Promise<void>;
  private readonly isReady: () => boolean;
  private readonly delaysMs: number[];
  private readonly onAttempt?: BrowserRecoveryOptions['onAttempt'];
  private readonly onFailure?: BrowserRecoveryOptions['onFailure'];
  private readonly onRecovered?: BrowserRecoveryOptions['onRecovered'];
  private loopPromise: Promise<boolean> | null = null;
  private stopped = false;
  private reason = 'Browser unavailable';
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeSleep: (() => void) | null = null;

  constructor(options: BrowserRecoveryOptions) {
    this.recover = options.recover;
    this.isReady = options.isReady;
    this.delaysMs = options.delaysMs?.length ? options.delaysMs : DEFAULT_DELAYS_MS;
    this.onAttempt = options.onAttempt;
    this.onFailure = options.onFailure;
    this.onRecovered = options.onRecovered;
  }

  request(reason: string): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    this.reason = reason;
    if (this.isReady()) return Promise.resolve(true);
    if (this.loopPromise) return this.loopPromise;

    const loop = this.runLoop();
    this.loopPromise = loop;
    void loop.finally(() => {
      if (this.loopPromise === loop) this.loopPromise = null;
    });
    return loop;
  }

  async ensureReady(reason: string, timeoutMs: number): Promise<boolean> {
    if (this.isReady()) return true;
    const recovery = this.request(reason);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    });
    const recovered = await Promise.race([recovery, timedOut]);
    if (timeout) clearTimeout(timeout);
    return recovered && this.isReady();
  }

  stop(): void {
    this.stopped = true;
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.wakeSleep?.();
    this.wakeSleep = null;
  }

  private async runLoop(): Promise<boolean> {
    let attempt = 1;
    while (!this.stopped && !this.isReady()) {
      if (attempt > 1) {
        const delayIndex = Math.min(attempt - 2, this.delaysMs.length - 1);
        await this.sleep(this.delaysMs[delayIndex]);
        if (this.stopped) return false;
      }

      const state = { attempt, reason: this.reason };
      this.onAttempt?.(state);
      try {
        await this.recover();
      } catch (error) {
        this.onFailure?.({ ...state, error });
      }

      if (this.isReady()) {
        this.onRecovered?.(state);
        return true;
      }
      attempt += 1;
    }
    return this.isReady();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        if (this.sleepTimer) clearTimeout(this.sleepTimer);
        this.sleepTimer = null;
        this.wakeSleep = null;
        resolve();
      };
      this.wakeSleep = finish;
      this.sleepTimer = setTimeout(finish, ms);
    });
  }
}
