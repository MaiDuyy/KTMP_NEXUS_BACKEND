# P4-C Verification Harness

`test-plan.json` is frozen before any main load run. It contains synthetic actors only and never stores credentials, browser state, or captured production content.

Run preflight after the topology is running. The script supplies the local P4-C
service URLs; the operator supplies three synthetic test actor identifiers and,
when the frontend is not on port 3002, its URL.

```powershell
$env:P4C_MEMBER_A = 'test-user-a'
$env:P4C_MEMBER_B = 'test-user-b'
$env:P4C_OUTSIDER_C = 'test-user-c'
$env:P4C_FRONTEND_URL = 'http://localhost:3002'
.\scripts\start-topology.ps1 preflight
```

The command reports only endpoint reachability and required environment variable names. It does not print values. A failed preflight blocks security, load, and browser acceptance; it does not change the frozen plan.

Main load and browser scenarios require the full topology, three isolated test identities, an observable LiveKit AI audio track, and redacted evidence outside Git.
