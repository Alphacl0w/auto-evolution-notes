# Research Log

## 2026-09-01 - Filesystem memory correction and invalidation

- Track: `agent-memory`
- Decision: publish a focused article on stale-current resolution instead of another filesystem-memory overview.
- Primary evidence: arXiv 2607.26637 v1, especially PersonaMem 32k results and Appendix D.1; PersonaMem official repository at `caaae44`; Mem0 source at `71fba8d`; Graphiti source at `8b61fce`.
- Distinctive angle: facts can be present and well cited while the current answer remains wrong because temporal validity was flattened during curation.
- Local check: `node experiments/filesystem-memory-invalidation.mjs` on Node v24.14.0; 32 slots, 200 filesystem reorderings, 6,400 queries. First-match current accuracy 50.38%; valid-time current and historical accuracy 100%; zero active-slot and source-preservation violations.
- Boundary: the local script isolates a storage invariant and is not a reproduction of the paper's LLM experiments. The paper v1 does not link a public replication repository.
