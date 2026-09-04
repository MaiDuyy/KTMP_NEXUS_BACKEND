# P4-C Verification Harness

`test-plan.json` is frozen before any main load run. It contains synthetic actors only and never stores credentials, browser state, or captured production content.

Run preflight from this directory with environment URLs injected by the operator:

```powershell
node scripts/preflight.mjs
```

The command reports only endpoint reachability and required environment variable names. It does not print values. A failed preflight blocks security, load, and browser acceptance; it does not change the frozen plan.

Main load and browser scenarios require the full topology, three isolated test identities, an observable LiveKit AI audio track, and redacted evidence outside Git.
