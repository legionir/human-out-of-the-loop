# Project Memory Skill

## Purpose
Keep what the project *knows* — decisions, constraints, ownership, gotchas —
across runs, instead of rediscovering it (or contradicting it) every time.

## Process
1. **Look first.** Before deciding or coding in an area, `search_nodes` for the
   topic. If the graph already records a decision, follow it — or revise it
   deliberately and say so.
2. `open_nodes` when you know the names: it returns each entity with every
   relation that touches it, including neighbours outside the result (their
   names are listed), so one call maps the neighbourhood.
3. **Write what will still matter tomorrow.** A fact belongs in memory when a
   future run would otherwise have to rediscover it: an architectural decision
   and its reason, a constraint ("the queue is at-least-once"), an owner
   ("payments-service owns the ledger"), a non-obvious gotcha.
4. Model it as entities (`{ name, entityType, observations }`) plus relations
   (`from`, `to`, `relationType` — an active verb like `depends_on`,
   `owned_by`, `supersedes`). Create both endpoints before the relation.
5. Extend rather than duplicate: `create_entities` leaves an existing entity
   alone, so use `add_observations` for new facts about it. Duplicate
   observations are skipped automatically.
6. Correct the graph when you learn better. Prefer `supersedes`: point the new
   entity at the old one so the history stays readable. (The `delete_*` tools
   exist and the `coder` persona has them — use them to prune what is plainly
   wrong or obsolete, never to hide a revision.)

## Constraints
- **Never** store secrets, tokens, credentials or personal data — memory is
  plain JSON in the project. The Journal redacts by key name; nothing redacts
  what you chose to write here.
- Do not dump whole files or long logs into observations; store the fact and
  the path.
- A relation to a missing entity is refused (`ENTITY_NOT_FOUND`) — create the
  entity first rather than working around it.
- The graph lives in `<project>/.ai-runtime/memory.json`; every write is atomic
  and locked, so parallel agents cannot lose an update. Read-modify-write
  through the tools — never edit the file by hand while an agent is running.
