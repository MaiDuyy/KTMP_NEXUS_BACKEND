import type { VoiceTurnState } from "@ott/shared";

const TERMINAL_STATES = new Set<VoiceTurnState>(["COMPLETED", "FAILED", "CANCELLED"]);

const ALLOWED_TRANSITIONS: Readonly<Record<VoiceTurnState, readonly VoiceTurnState[]>> = {
  IDLE: ["LISTENING", "CANCELLED"],
  LISTENING: ["FINALIZING_STT", "CANCELLING", "FAILED", "CANCELLED"],
  FINALIZING_STT: ["THINKING", "CANCELLING", "FAILED", "CANCELLED"],
  THINKING: ["RESPONDING", "CANCELLING", "FAILED", "CANCELLED"],
  RESPONDING: ["COMPLETED", "CANCELLING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  CANCELLING: ["CANCELLED", "FAILED"],
  FAILED: [],
  CANCELLED: [],
};

export interface VoiceTurnSnapshot {
  turnId: string;
  state: VoiceTurnState;
  updatedAt: string;
}

function assertIdentifier(value: string, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.trim() !== value) {
    throw new Error(`${fieldName} must be a non-empty identifier`);
  }

  return value;
}

/** In-memory deterministic state machine; durable orchestration is intentionally separate. */
export class VoiceTurnStateMachine {
  private readonly processedEventIds = new Set<string>();
  private state: VoiceTurnState;
  private updatedAt: Date;

  public constructor(
    private readonly turnId: string,
    initialState: VoiceTurnState = "LISTENING",
    now: Date = new Date(),
  ) {
    assertIdentifier(turnId, "turnId");
    this.state = initialState;
    this.updatedAt = now;
  }

  public transition(nextState: VoiceTurnState, eventId: string, now: Date = new Date()): VoiceTurnSnapshot {
    assertIdentifier(eventId, "eventId");
    if (this.processedEventIds.has(eventId)) {
      return this.snapshot();
    }
    if (TERMINAL_STATES.has(this.state)) {
      throw new Error(`cannot transition terminal state ${this.state}`);
    }
    if (!ALLOWED_TRANSITIONS[this.state].includes(nextState)) {
      throw new Error(`invalid voice turn transition: ${this.state} -> ${nextState}`);
    }

    this.processedEventIds.add(eventId);
    this.state = nextState;
    this.updatedAt = now;
    return this.snapshot();
  }

  public snapshot(): VoiceTurnSnapshot {
    return { turnId: this.turnId, state: this.state, updatedAt: this.updatedAt.toISOString() };
  }
}
