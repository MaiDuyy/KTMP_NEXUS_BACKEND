export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type ResilienceCircuitKey =
  | 'google_stt/batch'
  | 'google_stt/streaming'
  | 'meeting_ai/buffered'
  | 'meeting_ai/streaming'
  | 'google_tts/batch'
  | 'google_tts/streaming'
  | 'livekit/connect'
  | 'livekit/publish';

export type ResilienceProvider = 'google_stt' | 'google_tts' | 'meeting_ai' | 'livekit';

export function circuitKeyToProvider(key: ResilienceCircuitKey): ResilienceProvider {
  if (key.startsWith('google_stt')) return 'google_stt';
  if (key.startsWith('google_tts')) return 'google_tts';
  if (key.startsWith('meeting_ai')) return 'meeting_ai';
  return 'livekit';
}

export interface ResilienceObserver {
  recordCircuitTransition(name: ResilienceCircuitKey, state: CircuitState): void;
  recordCircuitRejection(name: ResilienceCircuitKey): void;
  recordRetryAttempt(operation: ResilienceCircuitKey): void;
  recordQuotaRejection(provider: ResilienceProvider): void;
}

let activeObserver: ResilienceObserver | null = null;

export function setResilienceObserver(observer: ResilienceObserver | null): () => void {
  activeObserver = observer;
  return () => {
    if (activeObserver === observer) {
      activeObserver = null;
    }
  };
}

export function getResilienceObserver(): ResilienceObserver | null {
  return activeObserver;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  openDurationMs: number;
  halfOpenProbeLimit: number;
  failureWindowMs?: number;
  clock?: () => number;
}

export interface ProviderResilienceConfig {
  circuitBreakerFailureThreshold: number;
  circuitBreakerOpenDurationMs: number;
  circuitBreakerHalfOpenProbeLimit: number;
  circuitBreakerFailureWindowMs: number;
  providerMaxRetryAttempts: number;
  providerRetryBaseBackoffMs: number;
  providerRetryMaxBackoffMs: number;
}

export interface CircuitPermit {
  recordSuccess(): void;
  recordFailure(): void;
  release(): void;
}

export class CircuitBreakerError extends Error {
  constructor(message: string = 'Circuit is OPEN') {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureTimestamps: number[] = [];
  private lastFailureTime = 0;
  private halfOpenProbes = 0;
  private readonly clock: () => number;

  constructor(
    public readonly name: ResilienceCircuitKey,
    private readonly config: CircuitBreakerConfig,
    private readonly onTransition?: (name: ResilienceCircuitKey, state: CircuitState) => void
  ) {
    if (config.failureThreshold < 1) {
      throw new Error('failureThreshold must be >= 1');
    }
    if (config.openDurationMs < 1) {
      throw new Error('openDurationMs must be >= 1');
    }
    if (config.halfOpenProbeLimit < 1) {
      throw new Error('halfOpenProbeLimit must be >= 1');
    }
    if (config.failureWindowMs !== undefined && config.failureWindowMs < 1) {
      throw new Error('failureWindowMs must be >= 1');
    }
    this.clock = config.clock || Date.now;
  }

  public acquire(): CircuitPermit {
    const now = this.clock();
    if (this.state === 'OPEN') {
      if (now - this.lastFailureTime >= this.config.openDurationMs) {
        this.transition('HALF_OPEN');
      } else {
        activeObserver?.recordCircuitRejection(this.name);
        throw new CircuitBreakerError();
      }
    }

    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenProbes >= this.config.halfOpenProbeLimit) {
        activeObserver?.recordCircuitRejection(this.name);
        throw new CircuitBreakerError();
      }
      this.halfOpenProbes++;
    }

    let settled = false;
    return {
      recordSuccess: () => {
        if (settled) return;
        settled = true;
        this.onSuccess();
      },
      recordFailure: () => {
        if (settled) return;
        settled = true;
        this.onFailure();
      },
      release: () => {
        if (settled) return;
        settled = true;
        this.onRelease();
      },
    };
  }

  public recordSuccess(): void {
    this.onSuccess();
  }

  public recordFailure(): void {
    this.onFailure();
  }

  public release(): void {
    this.onRelease();
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.transition('CLOSED');
    }
    this.failureTimestamps = [];
    this.halfOpenProbes = 0;
  }

  private onFailure(): void {
    const now = this.clock();
    if (this.state === 'HALF_OPEN') {
      this.transition('OPEN');
    } else if (this.state === 'CLOSED') {
      const windowMs = this.config.failureWindowMs ?? 60_000;
      this.failureTimestamps.push(now);
      this.failureTimestamps = this.failureTimestamps.filter((t) => now - t <= windowMs);
      if (this.failureTimestamps.length >= this.config.failureThreshold) {
        this.transition('OPEN');
      }
    }
  }

  private onRelease(): void {
    if (this.state === 'HALF_OPEN') {
      this.halfOpenProbes = Math.max(0, this.halfOpenProbes - 1);
    }
  }

  private transition(newState: CircuitState): void {
    if (this.state === newState) return;
    this.state = newState;
    if (newState === 'OPEN') {
      this.lastFailureTime = this.clock();
      this.halfOpenProbes = 0;
      this.failureTimestamps = [];
    } else if (newState === 'HALF_OPEN') {
      this.halfOpenProbes = 0;
    } else if (newState === 'CLOSED') {
      this.halfOpenProbes = 0;
      this.failureTimestamps = [];
    }
    this.onTransition?.(this.name, newState);
    activeObserver?.recordCircuitTransition(this.name, newState);
  }

  public getState(): CircuitState {
    return this.state;
  }
}

export interface RetryConfig {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  jitter?: boolean;
}

export interface ExecuteOptions<T> {
  operation: (remainingBudgetMs?: number) => Promise<T>;
  operationName?: ResilienceCircuitKey;
  circuitBreaker?: CircuitBreaker;
  retry?: RetryConfig;
  signal?: AbortSignal;
  deadlineMs?: number;
  clock?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  isTransientError: (err: unknown) => boolean;
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number) => void;
  mapError: (err: unknown, circuitOpen: boolean) => Error;
}

export function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('AbortError'));
    }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('AbortError'));
    };
    timer = setTimeout(() => {
      timer = undefined;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class Resilience {
  public static async execute<T>(options: ExecuteOptions<T>): Promise<T> {
    const clock = options.clock || Date.now;
    const sleep = options.sleep || cancellableSleep;
    const random = options.random || Math.random;
    const startTime = clock();
    let attempt = 1;

    while (true) {
      if (options.signal?.aborted) {
        throw options.mapError(new Error('AbortError'), false);
      }

      const elapsed = clock() - startTime;
      if (options.deadlineMs !== undefined && elapsed >= options.deadlineMs) {
        throw options.mapError(new Error('DeadlineExceeded'), false);
      }
      const remainingBudgetMs = options.deadlineMs !== undefined ? Math.max(0, options.deadlineMs - elapsed) : undefined;

      let permit: CircuitPermit | null = null;
      if (options.circuitBreaker) {
        try {
          permit = options.circuitBreaker.acquire();
        } catch (err) {
          if (err instanceof CircuitBreakerError) {
            throw options.mapError(err, true);
          }
          throw err;
        }
      }

      try {
        const result = await options.operation(remainingBudgetMs);
        permit?.recordSuccess();
        return result;
      } catch (err: unknown) {
        const isTransient = options.isTransientError(err);

        if (isTransient) {
          permit?.recordFailure();
        } else {
          permit?.release();
        }

        const mappedErr = options.mapError(err, false);
        const mappedCode = (mappedErr as any).code;
        const opKey = options.circuitBreaker?.name || options.operationName;
        if (mappedCode && typeof mappedCode === 'string' && mappedCode.includes('QUOTA_EXCEEDED') && opKey) {
          activeObserver?.recordQuotaRejection(circuitKeyToProvider(opKey));
        }

        if (options.signal?.aborted) {
          throw mappedErr;
        }

        const canRetryError = isTransient && (!options.shouldRetry || options.shouldRetry(err));

        if (!canRetryError || !options.retry || attempt >= options.retry.maxAttempts) {
          throw mappedErr;
        }

        const backoff = this.calculateBackoff(attempt, options.retry, random);
        const currentElapsed = clock() - startTime;
        if (options.deadlineMs !== undefined && currentElapsed + backoff >= options.deadlineMs) {
          // Backoff exceeds remaining deadline budget, fail with DeadlineExceeded
          throw options.mapError(new Error('DeadlineExceeded'), false);
        }

        options.onRetry?.(err, attempt);
        if (opKey) {
          activeObserver?.recordRetryAttempt(opKey);
        }

        try {
          await sleep(backoff, options.signal);
        } catch (sleepErr) {
          throw options.mapError(sleepErr, false);
        }
        attempt++;
      }
    }
  }

  private static calculateBackoff(attempt: number, config: RetryConfig, random: () => number): number {
    let delay = config.baseBackoffMs * Math.pow(2, attempt - 1);
    if (config.jitter !== false) {
      delay = delay * (0.5 + random() * 0.5);
    }
    return Math.min(delay, config.maxBackoffMs);
  }
}
