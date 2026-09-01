import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

export type VoiceTurnStartOutcome =
  | 'accepted'
  | 'feature_disabled'
  | 'invalid'
  | 'unauthorized'
  | 'unconfigured'
  | 'locked'
  | 'internal_error';
export type VoiceCleanupOutcome = 'completed' | 'failed' | 'retry_completed' | 'retry_failed';

export interface VoiceTurnMetrics {
  recordStart(outcome: VoiceTurnStartOutcome, durationSeconds: number): void;
  recordTerminal(state: 'COMPLETED' | 'FAILED' | 'CANCELLED'): void;
  recordTransportSelection?(selection: 'streaming' | 'batch_capability' | 'batch_server'): void;
}

export class VoiceControlMetrics implements VoiceTurnMetrics {
  public readonly registry = new Registry();
  private readonly starts = new Counter({
    name: 'meeting_voice_turn_start_total',
    help: 'Number of meeting voice turn start attempts by bounded outcome.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly terminals = new Counter({
    name: 'meeting_voice_turn_terminal_total',
    help: 'Number of meeting voice turns reaching a terminal state.',
    labelNames: ['state'] as const,
    registers: [this.registry],
  });
  private readonly lockDuration = new Histogram({
    name: 'meeting_voice_lock_acquire_duration_seconds',
    help: 'Duration of meeting voice start authorization and lock acquisition.',
    labelNames: ['outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [this.registry],
  });
  private readonly cleanup = new Counter({
    name: 'meeting_voice_cleanup_total',
    help: 'Number of meeting voice cleanup attempts by bounded outcome.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly pendingCleanup = new Gauge({
    name: 'meeting_voice_cleanup_pending',
    help: 'Current number of meeting voice cleanup commands pending in Redis.',
    registers: [this.registry],
  });
  private readonly transportSelections = new Counter({
    name: 'meeting_voice_transport_selection_total',
    help: 'Number of accepted voice turns by bounded transport selection.',
    labelNames: ['selection'] as const,
    registers: [this.registry],
  });

  public recordStart(outcome: VoiceTurnStartOutcome, durationSeconds: number): void {
    this.starts.inc({ outcome });
    this.lockDuration.observe({ outcome }, Math.max(0, durationSeconds));
  }

  public recordTerminal(state: 'COMPLETED' | 'FAILED' | 'CANCELLED'): void {
    this.terminals.inc({ state: state.toLowerCase() });
  }

  public recordTransportSelection(selection: 'streaming' | 'batch_capability' | 'batch_server'): void {
    this.transportSelections.inc({ selection });
  }

  public recordCleanup(outcome: VoiceCleanupOutcome): void {
    this.cleanup.inc({ outcome });
  }

  public setPendingCleanup(count: number): void {
    this.pendingCleanup.set(Math.max(0, count));
  }

  public render(): Promise<string> {
    return this.registry.metrics();
  }

  public get contentType(): string {
    return this.registry.contentType;
  }
}
