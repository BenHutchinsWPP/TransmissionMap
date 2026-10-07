# ADR-0003: Cross-tree types stay in `src/types.ts`

- Status: accepted
- Date: 2026-10-07
- Files: `src/types.ts`, `assets/state.ts`

## Context

`src/types.ts` scores as shallow because it is a file of type declarations with no behaviour. Types that had a single owner (`AppState`, `UserLayer`, `RasterMeta`) have moved to their modules. The remaining types are used across more than one tree:

| Type | Used in |
|---|---|
| `LayerDef` | `src/registry`, `assets`, `assets/layers`, `assets/ui` |
| `BucketDef` | `src/colors`, `assets`, `assets/ui` |
| `RampDef` | `src/colors`, `src/registry`, `assets/ui` |
| `StyleOverride` | `src/registry`, `assets` |

## Decision

Types shared across `src/registry`, `src/colors` and `assets` stay in `src/types.ts`, which imports nothing. A type with a single owning module lives in that module.

## Consequences

- Pure registry and colour code can import its types without pulling in map or state modules.
- Don't propose dissolving `src/types.ts` while these types are shared. Do move a type out once it narrows to one owner.
