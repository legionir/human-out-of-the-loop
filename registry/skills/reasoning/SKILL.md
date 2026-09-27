# Structured Reasoning & Time Skill

## Purpose
Turn hard problems into an explicit chain of numbered steps, and keep every
date, deadline and time zone in the answer factually correct.

## Process
1. Use `sequentialthinking` when a problem needs several **dependent** steps —
   a diagnosis, a design decision, a migration plan. One step per call, with
   `thoughtNumber`, an honest `totalThoughts` estimate, and
   `nextThoughtNeeded: false` on the last one.
2. When a step turns out to be wrong, do not silently restate it: send a new
   step with `isRevision: true` and `revisesThought: <number>`. When a
   sub-question needs its own chain, use `branchFromThought` + `branchId`
   instead of mixing it into the main line.
3. The chain persists in the project (`<project>/.ai-runtime/thinking/`), so a
   later turn — or a resumed run — continues with the same `sessionId` rather
   than rebuilding the reasoning. A session holds at most 50 steps: when it is
   close, summarise what is settled and start a new id.
4. Today's date is already in the ENVIRONMENT / system prompt. Use that clock.
   Call `get_current_time` only when you need another timezone or a conversion.
   Never guess a date from training data, and never assume the machine is in UTC.
5. Use `convert_time` for anything spanning zones — a standup, a release
   window, a deadline — and say which zone a time is in when you restate it.

## Constraints
- Do not use `sequentialthinking` for trivial steps; it is for reasoning that
  benefits from being reviewable, and every step is recorded in the Journal.
- `totalThoughts` is an estimate, not a contract: revising it is expected, and
  the adjustment is recorded rather than rejected.
- A time zone must be a real IANA name (`Asia/Tehran`, `Europe/Berlin`); an
  unknown one is refused with suggestions — read them instead of falling back
  to UTC.
- Report `isDST` honestly: an offset that looks "wrong" by one hour in summer is
  usually daylight saving, not a bug.
