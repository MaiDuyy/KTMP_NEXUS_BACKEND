import { describe, test as it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CircuitBreaker,
  CircuitBreakerError,
  Resilience,
  RetryConfig,
  cancellableSleep,
  setResilienceObserver,
  ResilienceObserver,
} from './resilience.js';

describe('CircuitBreaker', () => {
  let clockTime = 1000;
  const clock = () => clockTime;

  it('transitions closed -> open -> half-open -> closed', () => {
    const cb = new CircuitBreaker('google_stt/batch', { failureThreshold: 2, openDurationMs: 100, halfOpenProbeLimit: 1, clock });

    cb.recordFailure();
    assert.equal(cb.getState(), 'CLOSED');

    cb.recordFailure();
    assert.equal(cb.getState(), 'OPEN');

    assert.throws(() => cb.acquire(), CircuitBreakerError);

    clockTime += 100;
    const permit = cb.acquire();
    assert.equal(cb.getState(), 'HALF_OPEN');

    permit.recordSuccess();
    assert.equal(cb.getState(), 'CLOSED');
  });

  it('transitions half-open -> open on failure', () => {
    const cb = new CircuitBreaker('google_stt/batch', { failureThreshold: 1, openDurationMs: 100, halfOpenProbeLimit: 1, clock });
    cb.recordFailure();
    assert.equal(cb.getState(), 'OPEN');
    clockTime += 100;
    const permit = cb.acquire();

    permit.recordFailure();
    assert.equal(cb.getState(), 'OPEN');
  });

  it('limits concurrent half-open probes', () => {
    const cb = new CircuitBreaker('google_stt/batch', { failureThreshold: 1, openDurationMs: 100, halfOpenProbeLimit: 2, clock });
    cb.recordFailure();
    clockTime += 100;

    const p1 = cb.acquire();
    const p2 = cb.acquire();
    assert.throws(() => cb.acquire(), CircuitBreakerError);

    p1.release();
    const p3 = cb.acquire(); // Can acquire again since p1 was released!
    assert.ok(p3);
  });

  it('does not get stuck in HALF_OPEN on permanent error, quota, or cancel (HIGH-02)', () => {
    const cb = new CircuitBreaker('google_stt/batch', { failureThreshold: 1, openDurationMs: 100, halfOpenProbeLimit: 1, clock });
    cb.recordFailure();
    assert.equal(cb.getState(), 'OPEN');
    clockTime += 100;

    // Permit 1: released due to permanent error / quota
    const p1 = cb.acquire();
    assert.equal(cb.getState(), 'HALF_OPEN');
    p1.release(); // slot returned

    // Second probe must NOT be rejected!
    const p2 = cb.acquire();
    assert.equal(cb.getState(), 'HALF_OPEN');
    p2.release(); // slot returned

    // Third probe succeeds and closes circuit
    const p3 = cb.acquire();
    p3.recordSuccess();
    assert.equal(cb.getState(), 'CLOSED');
  });

  it('enforces rolling failure window so old failures expire and do not open circuit', () => {
    let now = 1000;
    const cb = new CircuitBreaker('google_stt/batch', {
      failureThreshold: 3,
      openDurationMs: 1000,
      halfOpenProbeLimit: 1,
      failureWindowMs: 1000,
      clock: () => now,
    });

    cb.recordFailure(); // at t=1000
    assert.equal(cb.getState(), 'CLOSED');

    now += 400; // t=1400
    cb.recordFailure(); // at t=1400
    assert.equal(cb.getState(), 'CLOSED');

    now += 700; // t=2100 (t=1000 has expired since 2100 - 1000 = 1100 > 1000)
    cb.recordFailure(); // at t=2100: only 2 failures in window (1400 and 2100)
    assert.equal(cb.getState(), 'CLOSED');

    now += 200; // t=2300: 3 failures in window (1400, 2100, 2300)
    cb.recordFailure(); // at t=2300
    assert.equal(cb.getState(), 'OPEN');
  });

  it('validates config limits on construction', () => {
    assert.throws(() => new CircuitBreaker('google_stt/batch', { failureThreshold: 0, openDurationMs: 100, halfOpenProbeLimit: 1 }), /failureThreshold/);
    assert.throws(() => new CircuitBreaker('google_stt/batch', { failureThreshold: 1, openDurationMs: 0, halfOpenProbeLimit: 1 }), /openDurationMs/);
    assert.throws(() => new CircuitBreaker('google_stt/batch', { failureThreshold: 1, openDurationMs: 100, halfOpenProbeLimit: 0 }), /halfOpenProbeLimit/);
    assert.throws(() => new CircuitBreaker('google_stt/batch', { failureThreshold: 1, openDurationMs: 100, halfOpenProbeLimit: 1, failureWindowMs: 0 }), /failureWindowMs/);
  });
});

describe('Resilience', () => {
  const retryConfig: RetryConfig = {
    maxAttempts: 2,
    baseBackoffMs: 10,
    maxBackoffMs: 50,
    jitter: false
  };

  it('retries transient errors up to maxAttempts', async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls < 2) throw new Error('transient');
      return 'ok';
    };

    const result = await Resilience.execute({
      operation: op,
      retry: retryConfig,
      isTransientError: (err: any) => err.message === 'transient',
      mapError: (err: any) => err
    });

    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });

  it('does not retry permanent errors and releases half-open permit', async () => {
    let clockTime = 1000;
    const cb = new CircuitBreaker('google_stt/batch', { failureThreshold: 1, openDurationMs: 50, halfOpenProbeLimit: 1, clock: () => clockTime });
    cb.recordFailure();
    clockTime += 100;

    let calls = 0;
    await assert.rejects(async () => {
      await Resilience.execute({
        operation: async () => {
          calls++;
          throw new Error('permanent');
        },
        circuitBreaker: cb,
        retry: retryConfig,
        isTransientError: () => false,
        mapError: (err: any) => err
      });
    }, /permanent/);

    assert.equal(calls, 1);
    assert.equal(cb.getState(), 'HALF_OPEN');

    // Next call must be allowed through because permit was released!
    const pNext = cb.acquire();
    pNext.recordSuccess();
    assert.equal(cb.getState(), 'CLOSED');
  });

  it('enforces total deadline budget across attempts', async () => {
    let virtualClock = 0;
    let receivedBudgets: (number | undefined)[] = [];
    let calls = 0;

    const op = async (budgetMs?: number) => {
      calls++;
      receivedBudgets.push(budgetMs);
      virtualClock += 30; // 30ms passed in attempt
      if (calls === 1) throw new Error('transient');
      return 'done';
    };

    const result = await Resilience.execute({
      operation: op,
      deadlineMs: 100,
      clock: () => virtualClock,
      sleep: async () => { virtualClock += 10; }, // fake sleep adds 10ms
      retry: retryConfig,
      isTransientError: () => true,
      mapError: (err: any) => err
    });

    assert.equal(result, 'done');
    assert.equal(calls, 2);
    assert.equal(receivedBudgets[0], 100);
    assert.equal(receivedBudgets[1], 60); // 100 - 30 - 10
  });

  it('cancellableSleep cleans up abort listener properly on resolve and abort', async () => {
    const controller = new AbortController();
    let listenersCount = 0;
    const origAdd = controller.signal.addEventListener.bind(controller.signal);
    const origRemove = controller.signal.removeEventListener.bind(controller.signal);

    controller.signal.addEventListener = (type: any, listener: any, options: any) => {
      listenersCount++;
      return origAdd(type, listener, options);
    };
    controller.signal.removeEventListener = (type: any, listener: any) => {
      listenersCount--;
      return origRemove(type, listener);
    };

    // Case 1: Normal resolve
    await cancellableSleep(10, controller.signal);
    assert.equal(listenersCount, 0, 'Listener must be removed after normal sleep');

    // Case 2: Abort
    const abortCtrl = new AbortController();
    setTimeout(() => abortCtrl.abort(), 10);
    await assert.rejects(cancellableSleep(1000, abortCtrl.signal), /AbortError/);
  });

  it('observer records metrics without listener leak', () => {
    let transitions: any[] = [];
    let rejections: any[] = [];
    let retries: any[] = [];
    let quotas: any[] = [];

    const observer: ResilienceObserver = {
      recordCircuitTransition: (name, state) => transitions.push({ name, state }),
      recordCircuitRejection: (name) => rejections.push(name),
      recordRetryAttempt: (op) => retries.push(op),
      recordQuotaRejection: (p) => quotas.push(p),
    };

    const unsubscribe = setResilienceObserver(observer);
    const cb = new CircuitBreaker('google_stt/batch', { failureThreshold: 1, openDurationMs: 100, halfOpenProbeLimit: 1 });
    cb.recordFailure();

    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].state, 'OPEN');

    unsubscribe();
    cb.recordFailure(); // After unsubscribe, observer should not be called
    assert.equal(transitions.length, 1);
  });
});
