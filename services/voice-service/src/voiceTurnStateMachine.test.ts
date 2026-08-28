import assert from "node:assert/strict";
import test from "node:test";
import { VoiceTurnStateMachine } from "./voiceTurnStateMachine.js";

test("allows the batch voice lifecycle through final response", () => {
  const machine = new VoiceTurnStateMachine("turn-1", "LISTENING", new Date("2026-08-28T00:00:00.000Z"));

  assert.equal(machine.transition("FINALIZING_STT", "event-1").state, "FINALIZING_STT");
  assert.equal(machine.transition("THINKING", "event-2").state, "THINKING");
  assert.equal(machine.transition("RESPONDING", "event-3").state, "RESPONDING");
  assert.equal(machine.transition("COMPLETED", "event-4").state, "COMPLETED");
});

test("rejects skipped and post-terminal transitions", () => {
  const machine = new VoiceTurnStateMachine("turn-1");
  assert.throws(() => machine.transition("RESPONDING", "event-1"), /invalid voice turn transition/);

  machine.transition("CANCELLED", "event-2");
  assert.throws(() => machine.transition("LISTENING", "event-3"), /terminal state CANCELLED/);
});

test("does not apply the same event twice", () => {
  const machine = new VoiceTurnStateMachine("turn-1");
  const first = machine.transition("FINALIZING_STT", "event-1", new Date("2026-08-28T00:00:01.000Z"));
  const duplicate = machine.transition("THINKING", "event-1", new Date("2026-08-28T00:00:02.000Z"));

  assert.deepEqual(duplicate, first);
});
