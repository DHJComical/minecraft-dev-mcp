# AGENT HANDBOOK – Minecraft Dev MCP

Reference for AI/agent operators working in this repo. Grounded in `CLAUDE.md` and current project state.

## Project Snapshot
- MCP server that lets agents decompile, remap, search, and analyze Minecraft (1.7.10+; obfuscated through 1.21.11, unobfuscated after the 26.1 cutover). Pre-1.14.4 versions (1.7.10–1.12.2) use Forge **MCP** mappings.
- Phase 1 & 2 complete (core + advanced tools); 29 integration tests green as of 2025-12-06.
- Phase 3 complete (third-party mod analysis, 2025-12-15): mod decompilation/search/indexing tools exist (`decompile_mod_jar`, `search_mod_code`, `index_mod`, `search_mod_indexed`).
- Stack: Node 18+/ESM-only (`"type": "module"`), TS 5.7, Java 17+ (21+ for newest MC), better-sqlite3, VineFlower decompiler, tiny-remapper.

## What Agents Should Prioritize
- Keep ESM intact: no CommonJS, ensure `.js` extensions on local imports after build.
- Registry extraction must use the obfuscated **server JAR** with version-aware bundler flag; never the client JAR. Unsupported for <1.13 (no data generator).
- Yarn remapping is two-step: official → intermediary → yarn; do not collapse into one pass.
- MCP remapping (1.7.10–1.12.2) is single-step obf→MCP SRG with `ignoreFieldDesc`; the SRG `FD:` lines carry no descriptors. Verified MCP stable builds live in `MCP_STABLE_BUILD` (`src/downloaders/mcp-downloader.ts`); patch versions without their own stable CSV alias the nearest one because MCP SRG ids are globally permanent.
- Respect cache layout in platform app data (`jars/`, `mappings/`, `remapped/`, `decompiled/{version}/{mapping}/`, `registry/{version}/`, `resources/`, `search-index/`, `cache.db`).
- VineFlower drops `libraries/`, `versions/`, `logs/` in CWD during runs; temporary and gitignored.

## Architecture Wayfinder (src/)
- `services/`: `version-manager` (JARs), `mapping-service` (Yarn/Mojmap/Intermediary/MCP), `remap-service` (two-step Yarn/Mojmap; single-step MCP), `decompile-service` (VineFlower), `registry-service` (data generator on server JAR).
- `java/`: `tiny-remapper`, `vineflower`, `mc-data-gen` (bundler vs legacy invocation), `java-process` (exec wrapper).
- `downloaders/`: Mojang assets/mappings, Yarn mappings, MCP mappings (Forge maven → SRG+CSV → obf→MCP), Java tool JARs.
- `cache/`: cache manager + SQLite metadata DB.
- `utils/paths.ts`: resolves OS-specific cache roots; `utils/mcp-mappings.ts`: SRG↔CSV join + SRG lookup.

## Available MCP Tools (for LLM surfaces)
- Phase 1 core: `get_minecraft_source`, `decompile_minecraft_version`, `list_minecraft_versions`, `get_registry_data`.
- Phase 2 analysis: `remap_mod_jar`, `find_mapping`, `search_minecraft_code`, `compare_versions`, `analyze_mixin`, `validate_access_widener`, `validate_access_transformer`, `compare_versions_detailed`, `index_minecraft_version`, `search_indexed`, `get_documentation`, `search_documentation`.
- Phase 3: `analyze_mod_jar`, `decompile_mod_jar`, `search_mod_code`, `index_mod`, `search_mod_indexed` (mod metadata/mixins/bytecode scan, decompile, search, indexing).

## Critical Behaviors & Pitfalls
- **Registry paths**: MC ≥1.21 writes `reports/registries.json`; <1.21 uses `generated/reports/registries.json`. Names are singular (`block`, `item`, `entity`), auto-prefixed with `minecraft:` if absent.
- **Java invocation**: MC 1.18+ bundler needs `-DbundlerMainClass=net.minecraft.data.Main`; pre-1.18 uses `-cp` mode.
- **MCP (pre-1.14.4) mappings**: `mcp-<version>-srg.zip` joined.srg + `mcp_stable-<build>` CSVs are joined by `utils/mcp-mappings.ts`; the generated file puts `FD:` lines first (mapping-io detectFormat workaround), so any consumer must parse it order-independently (see `lookupInMcpSrg`).
- **Performance**: first decompile downloads/remaps (~400–500 MB/version; old versions are far smaller — the 1.7.10 client JAR is ~5 MB). Caching makes subsequent requests near-instant.
- **Integrity**: downloads are SHA-verified; cache rebuilds on corruption; Java processes run with timeouts and memory caps.

## Testing & Commands
- Fast suite: `npm test` (vitest, targets 1.21.10 pipeline end-to-end).
- Manual/versioned suites: `npm run test:manual` (Yarn 1.21.10/1.20.1/1.19.4, MCP 1.12.2/1.7.10, patched), `npm run test:manual:mojmap` (+ version-specific overrides).
- Dev/build: `npm run dev` (tsx watch), `npm run build`, `npm run typecheck`, `npm run lint[:fix]`.
- Full sweep: `npm run test:all` (CI + manual).

## Active TODO / Gaps
- None currently; see `docs/specs/` for future candidates.

## Quick Playbooks
- Retrieve class source: ensure version cached → `get_minecraft_source(version, className, mapping)`; triggers download/remap/decompile if missing.
- Extract registries: use `registry-service` with server JAR and version-aware path detection; fail fast on wrong registry names (unsupported entirely for <1.13).
- Add new mapping type: extend `MappingType`, add downloader, wire into `mapping-service`, add tests.
- Add manual test for version: copy template under `__tests__/manual/vX.Y.Z`, add script `test:manual:X.Y.Z`.
- Add an older MCP version: append its verified stable build to `MCP_STABLE_BUILD` (`src/downloaders/mcp-downloader.ts`) after HEAD-checking `mcp-<v>-srg.zip` and `mcp_stable-<build>.zip` on maven.minecraftforge.net.

## Support Files & References
- Primary context: `CLAUDE.md` (architecture, constraints, known issues).
- Manual test guide: `__tests__/manual/README.md`.
