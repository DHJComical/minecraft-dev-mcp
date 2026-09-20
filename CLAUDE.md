# Claude Code Context - Minecraft Dev MCP

This document provides essential context for working with the Minecraft Dev MCP codebase.

## Project Overview

This is a **Model Context Protocol (MCP) server** that provides AI assistants with access to decompiled Minecraft source code, registry data, and modding tools. It enables LLMs to help developers with Minecraft mod development by providing accurate, version-specific source code and game data.

## Release Status

- **Phase 1 & 2 complete** (core services, remap/decompile/search/compare) as of 2025-12-06; 29 integration tests pass end-to-end.
- **Phase 3 complete** (third-party mod analysis) as of 2025-12-15; includes full mod decompilation, search, and indexing capabilities with WSL support.
- **Mod tools are loader-era aware, not version-gated** (2025-12-16): `analyze_mod_jar` handles legacy Forge 1.6.4–1.12.2 (`mcmod.info`), Forge 1.13–1.20.x/NeoForge (`mods.toml` with dependency blocks), and Fabric/Quilt, backfilling from `MANIFEST.MF` and bytecode; legacy SRG-named access transformers validate under `mapping: 'mcp'`. 669 tests green (`npm test`).

## Architecture

### Core Services (`src/services/`)

1. **version-manager.ts** - Downloads and manages Minecraft client/server JARs from Mojang
   - `getVersionJar()` - Downloads client JAR (for remapping/decompilation)
   - `getServerJar()` - Downloads server JAR (for registry extraction)
   - Caches JARs in AppData/config directory

2. **mapping-service.ts** - Downloads and manages mappings (Yarn, Mojmap, Intermediary, MCP)
   - Yarn: Community mappings (best for mod development)
   - Mojmap: Official Mojang mappings
   - Intermediary: Fabric's stable intermediate mapping format
   - Feather/Calamus: Ornithe mappings for pre-1.7.10 versions (alpha 1.0.10
     through 1.6.4) — the only readable-names channel for those eras. Two-step
     remap official → calamus → feather from `maven.ornithemc.net` tiny v2
     artifacts (`downloaders/ornithe-downloader.ts`); pre-1.3 versions use
     split `-client` artifacts (client JAR only). See also `find_mapping`
     bridging through calamus.
   - MCP: Forge ModCoderPack mappings for pre-1.14.4 versions (1.7.10–1.13.2;
     1.7.10 is the oldest with artifacts on the Forge maven, and 1.13.x has no
     yarn/intermediary at all), reconstructed at build time from
     `de.oceanlabs.mcp:mcp:<v>:srg` (joined.srg) for 1.7.10–1.12.2 or
     `de.oceanlabs.mcp:mcp_config:<v>` (config/joined.tsrg via `tsrgToSrg`)
     for 1.13.x + `mcp_stable` CSV (fields/methods.csv) into an obf→MCP SRG.
     The verified stable-build tables are `MCP_STABLE_BUILD`/`MCP_CONFIG_VERSIONS`
     in `src/downloaders/mcp-downloader.ts`; versions without their own stable
     CSV (1.9.2, 1.10, 1.11.1, 1.13.1) alias the nearest one because MCP SRG
     ids are globally permanent

3. **remap-service.ts** - Remaps obfuscated Minecraft JARs using mappings
   - Uses tiny-remapper Java tool
   - `remap_mod_jar` is loader-aware: Fabric/Quilt mods remap
     intermediary→named; Forge/NeoForge mods for 1.7.10–1.13.2 ship SRG
     member names, so a member-only SRG→MCP mapping (`buildSrgToMcpMapping`,
     cached at `mcp-srg-<v>.srg`) renames members while class names stay
     identical, with the SRG-named vanilla JAR (`mcp-srg-vanilla-<v>.jar`,
     built from the ordered obf→SRG mapping) passed to tiny-remapper as
     classpath for inheritance resolution. 1.14+ Forge mods are not
     supported (no published SRG→member mappings for those eras)
   - Converts obfuscated names → human-readable names
   - **Yarn requires 2-step remapping**: obfuscated → intermediary → yarn

4. **decompile-service.ts** - Decompiles remapped JARs to Java source
   - Uses VineFlower decompiler
   - Produces readable Java source code
   - Caches decompiled sources for reuse

5. **registry-service.ts** - Extracts Minecraft registry data (blocks, items, entities, etc.)
   - **CRITICAL**: Must use SERVER JAR, not client JAR
   - Uses Minecraft's built-in data generator (`--reports` flag)
   - Handles both modern (1.18+) and legacy (<1.18) formats

6. **source-service.ts** - Main orchestration service
   - Coordinates version management → remapping → decompilation
   - Provides `getMinecraftSource()` for retrieving specific class source code
   - Handles caching and progress reporting

### Java Tool Wrappers (`src/java/`)

1. **tiny-remapper.ts** - Wraps tiny-remapper JAR for remapping obfuscated classes
   - Handles namespace conversions (official → intermediary → named)
   - Uses tiny-remapper 0.12.0 (multi-threaded ASM remapper)

2. **vineflower.ts** - Wraps VineFlower JAR for decompilation
   - **Creates temporary folders**: `libraries/`, `versions/`, `logs/` in CWD during decompilation
   - These are VineFlower's workspace files and should be gitignored
   - Defaults align with Vineflower 1.11.2 (`-dgs=1 -hdc=0 -asc=1 -rsy=1 -lit=1`)

3. **mc-data-gen.ts** - Runs Minecraft's data generator to extract registry data
   - **MC 1.18+**: Uses bundler format: `java -DbundlerMainClass=net.minecraft.data.Main -jar server.jar`
   - **MC <1.18**: Uses legacy format: `java -cp server.jar net.minecraft.data.Main`
   - Checks multiple locations for `registries.json`:
     - MC 1.21+: `reports/registries.json`
     - MC <1.21: `generated/reports/registries.json`

4. **java-process.ts** - Low-level Java process execution wrapper
   - Supports both `-jar` and `-cp` modes
   - Handles JVM args (e.g., `-DbundlerMainClass`)
   - Provides timeout, progress tracking, and error handling

### Downloaders (`src/downloaders/`)

1. **mojang-downloader.ts** - Downloads JARs and mappings from Mojang
   - `downloadClientJar()` - Client JAR (for playing/remapping)
   - `downloadServerJar()` - Server JAR (for registry extraction)
   - `downloadMojangMappings()` - Official Mojang mappings
   - All downloads include SHA-1 verification

2. **yarn-downloader.ts** - Downloads Yarn mappings from Fabric Maven
   - Uses Maven API to find available versions
   - Downloads and converts to Tiny v2 format

3. **java-resources.ts** - Downloads Java tool JARs (VineFlower, tiny-remapper)
   - Caches in AppData/resources directory

### Cache Management (`src/cache/`)

1. **cache-manager.ts** - High-level cache operations
   - Checks if versions/mappings/decompiled sources exist
   - Returns cached paths

2. **database.ts** - SQLite database for metadata
   - Tracks versions, mappings, decompilation jobs
   - Stores access times for cache cleanup

### Paths and Storage (`src/utils/paths.ts`)

**Cache Directory Structure**:
- Windows: `%APPDATA%\minecraft-dev-mcp\`
- macOS: `~/Library/Application Support/minecraft-dev-mcp/`
- Linux: `~/.config/minecraft-dev-mcp/`

**Subdirectories**:
- `jars/` - Client and server JARs
  - `minecraft_client.{version}.jar`
  - `minecraft_server.{version}.jar`
- `mappings/` - Mapping files (Tiny format)
- `remapped/` - Remapped JARs
- `decompiled/{version}/{mapping}/` - Decompiled source code
- `registry/{version}/` - Registry data
- `resources/` - Java tool JARs (VineFlower, tiny-remapper)
- Central cache is shared across workspaces; expect ~400–450 MB per MC version (JAR + mappings + remapped + decompiled + registry).
- Patched-MC variants (Forge/NeoForge — see `decompile_minecraft_version`'s `jarPath`) reuse the same `decompiled/{version}/{mapping}/` layout under a version key like `1.21.1-neoforge-21.1.72`, adding ~250–400 MB per variant on top of vanilla.

## Build & ESM Requirements

- ESM-only: `package.json` must keep `"type": "module"`; `tsconfig` uses `"module": "ES2022"`/bundler resolution.
- Local imports must include `.js` extensions after build (e.g., `./utils.js`), not `.ts`.
- No CommonJS `require`; all tooling/scripts assume ES modules.

## Critical Implementation Details

### Registry Extraction (IMPORTANT!)

**Problem Solved**: Registry extraction was failing because it tried to use the remapped client JAR.

**Solution**:
1. **Always use SERVER JAR** - The server JAR has the built-in data generator
2. **Use obfuscated JAR** - Don't remap it, the server JAR runs fine obfuscated
3. **Handle bundler format** - MC 1.18+ uses a bundler format that requires `-DbundlerMainClass`

**Implementation** (`src/services/registry-service.ts`):
```typescript
// Get SERVER JAR (not client!)
const serverJarPath = await this.versionManager.getServerJar(version);

// Run data generator with version-specific format
const registriesFile = await this.dataGen.generateRegistryData(
  serverJarPath,
  registryDir,
  version // Used to detect if bundler format needed
);
```

**Registry Names**:
- Use singular form: `block`, `item`, `entity` (NOT `blocks`, `items`, `entities`)
- Full names include namespace: `minecraft:block`, `minecraft:item`
- The code auto-adds `minecraft:` prefix if not present

### Yarn Mapping Remapping (Two-Step Process)

Yarn mappings require **two separate remapping operations**:

1. **Official → Intermediary**: Remap from obfuscated to Fabric's stable intermediary names
2. **Intermediary → Yarn**: Remap from intermediary to human-readable Yarn names

**Why?** Yarn builds on top of Intermediary to provide stable mappings across Minecraft versions.

**Implementation** (`src/services/remap-service.ts`):
```typescript
// Step 1: official → intermediary
const intermediaryJar = await this.tinyRemapper.remap(
  inputJar,
  intermediaryPath,
  intermediateMappings,
  'official', 'intermediary'
);

// Step 2: intermediary → named (yarn)
const yarnJar = await this.tinyRemapper.remap(
  intermediaryJar,
  outputPath,
  yarnMappings,
  'intermediary', 'named'
);
```

### VineFlower Temporary Files

VineFlower creates these folders in the **current working directory** during decompilation:
- `libraries/` - Extracted Minecraft libraries for dependency resolution
- `versions/` - Minecraft version metadata
- `logs/` - Decompilation logs

**These are temporary and gitignored** - but the actual decompiled sources go to AppData.

### Mod Metadata Is Loader-Era Specific (`src/parsers/`, `mod-analyzer-service.ts`)

The metadata format changed twice, so the analyzer dispatches on what the JAR
actually contains — never on a version guess:

| Era | File | Read by |
| --- | --- | --- |
| Fabric/Quilt | `fabric.mod.json` / `quilt.mod.json` | `parseFabricMetadata` / `parseQuiltMetadata` |
| Forge 1.13–1.20.x / NeoForge | `META-INF/mods.toml` / `neoforge.mods.toml` | `parsers/mods-toml.ts` (purpose-built TOML subset: `[[mods]]`, `[[dependencies.<owner>]]`, `[[mixins]]`, `[[accessTransformers]]`) |
| Forge 1.6.4–1.12.2 | root `mcmod.info` (JSON) | `parsers/mcmod-info.ts` |

Three things are ALWAYS backfilled, because no metadata file carries them:

1. **`META-INF/MANIFEST.MF`** (`parsers/jar-manifest.ts`): `MixinConfigs` (legacy
   mods name configs anything — `mixins.betterf1.json` — so a `*.mixins.json`
   scan is not enough), `FMLAT` (access transformers), `FMLCorePlugin` /
   `TweakClass` / `Main-Class` (legacy coremod/tweaker entry points), and
   `Implementation-Version` (id/version fallback for gradle `-dev` jars).
2. **Class files** (`parsers/class-file.ts`, dependency-free): `@Mod` ids,
   legacy coremod interfaces (`IFMLLoadingPlugin`, `DummyModContainer`,
   `ITweaker`), and `@Mixin` targets. `@Mixin` is `RetentionPolicy.CLASS` and
   therefore lives in **`RuntimeInvisibleAnnotations`** — reading only the
   visible attribute yields zero targets; Forge's `@Mod` is RUNTIME, so both
   attributes must be parsed.
3. **A `warnings` array on the result**: anything not determined is *reported*,
   never invented. `isDetectedModId` / `isDetectedModVersion` treat the
   `unknown` / `0.0.0` sentinels AND unresolved `${...}` Gradle placeholders as
   "not detected"; `decompile_mod_jar` then fails with instructions instead of
   caching the mod at `decompiled-mods/unknown/0.0.0/<mapping>` (a directory
   every unidentified mod would share, handing one mod's source to another).

Legacy Forge quirks encoded in `parseForgeMetadata`: `mcversion` becomes a
synthetic `minecraft` dependency (this is what makes `remap_mod_jar` version
auto-detection work for 1.12.2 mods), `requiredMods` are `required` while
`dependencies`/`dependants` are load-ORDER constraints (`type: 'ordering'`), and
`authorList: ["A, B, C"]` is comma-split.

### Legacy Access Transformers Use SRG Member Names

Pre-1.17 Forge AT files name members by SRG id with already-readable class
names:

```
public net.minecraft.client.Minecraft field_71428_T
```

The remapped JAR this validator reads under `mapping: 'mcp'` is MCP-named, so
without translation every entry reported "not found". `AccessTransformerService`
now resolves ids through the `mcp_stable` CSVs (`getMcpMemberNames`, from
`downloaders/mcp-downloader.ts`) before lookup — the same resolution the loader
performs — while still reporting findings against the line the user wrote
(`translateSrgMemberNames` is a pure, exported seam). SRG ids are globally
permanent, which is why a later build's CSV resolves an earlier version's ids.

Only MEMBER names are translated, which is sufficient because of how the two
eras differ in what SRG names look like:

- **1.7.10–1.12.2**: the official JAR obfuscates members only, so a class name is
  identical in SRG and MCP space (`net.minecraft.client.Minecraft`) and both the
  AT's class names and its method descriptors already match the MCP-named JAR.
- **1.13.x**: the official JAR also obfuscates class names (`a` →
  `net/minecraft/util/text/TextFormatting`), but mod ATs are authored in the
  MCP-named dev workspace, so they carry READABLE class names with SRG member
  ids — again exactly what the member-only translation expects.

Known limitation (deliberately not guessed at): an AT written against
obfuscated 1.13.x class names would not resolve, because translating those would
require inverting the `mcp_config` class map rather than the CSVs.

## Testing

### Integration Tests (`__tests__/integration.test.ts`)

Tests the entire pipeline end-to-end:
1. Version management (list, download)
2. JAR download and caching
3. Mapping download (Yarn)
4. JAR remapping (Yarn 2-step process)
5. Source code decompilation
6. **Registry extraction** (blocks, items)
7. MCP tool integration
8. Error handling

**Test Configuration** (`vitest.config.ts`):
- `watch: false` - Exit after tests finish (don't watch for changes)
- `testTimeout: 600000` - 10 minute timeout for long operations
- Tests use version `1.21.10` as the test target

**Running Tests**:
```bash
npm test  # Runs all integration tests
```

### Patched-JAR Suite (`__tests__/manual/patched/`)

Env-driven E2E suite that exercises the full patched-MC pipeline (decompile/extract → get_minecraft_source → search → index → vanilla-vs-patched compare → force re-run). Skips cleanly when `PATCHED_JAR_PATH` is unset.

CI generates real patched JARs via `.github/workflows/patched-jars.yml`:
- NeoForge matrix (1.20.4, 1.21.1, 1.21.4) via NeoFormRuntime (`nfrt run --dist joined --neoforge ...:userdev`)
- Forge 1.20.1 via a tiny ForgeGradle 6 fixture project (`gradle eclipse` triggers lazy materialization — FG6 has no equivalent of FG5's `setupDecompWorkspace`)

Triggered on `workflow_dispatch` and on main pushes that touch the patched-JAR surface. Out of default PR CI to keep it fast.

Local run against your own JAR:
```bash
PATCHED_JAR_PATH=/path/to/patched.jar \
PATCHED_VERSION=1.21.1-neoforge-21.1.72 \
PATCHED_MC_VERSION=1.21.1 \
PATCHED_LOADER=neoforge \
npm run test:manual:patched
```

### Mod-Metadata Suites (no Java, no network)

- `__tests__/parsers/legacy-metadata.test.ts` — `mcmod.info`, `mods.toml` (dependency blocks, half-open ranges, NeoForge `type`), `MANIFEST.MF` (folding, sections, case-insensitivity).
- `__tests__/parsers/class-file.test.ts` — the dependency-free `.class` reader against the committed fixture `__tests__/fixtures/legacy-forge-1.12.2.jar` (rebuild: `__tests__/fixtures/legacy-forge-src/build.sh`). Pins the CLASS-retention `@Mixin` case and descriptor decoding.
- `__tests__/services/mod-analyzer-service.test.ts` — Fabric (Meteor) plus the legacy fixture end to end, including the "warnings instead of invented values" behavior.
- `__tests__/services/access-transformer-srg.test.ts` — `translateSrgMemberNames` and its effect on `validateEntryAgainstBytecode` (includes the pre-fix failing case).

### Legacy-Mod Suite (`__tests__/manual/legacy-mod/`)

Env-driven E2E suite for a REAL pre-1.14 Forge mod: analyze (`mcmod.info`) → remap (loader + version auto-detected, SRG → MCP) → decompile → validate an SRG-named AT. Skips cleanly when `LEGACY_MOD_JAR` is unset.

```bash
LEGACY_MOD_JAR=/mods/StorageDrawers-1.12.2-5.5.3.jar \
LEGACY_MOD_MC=1.12.2 \
LEGACY_MOD_ID=storagedrawers \
LEGACY_MOD_AT=/mods/legacymod_at.cfg \
npm run test:manual:legacy-mod
```

## Common Tasks

### Adding Support for a New Mapping Type

1. Add the type to `src/types/minecraft.ts`: `MappingType`
2. Create downloader in `src/downloaders/{type}-downloader.ts`
3. Update `mapping-service.ts` to handle the new type
4. Add test cases

### Debugging Registry Extraction Issues

1. Check the Java command being executed (logged by `java-process.ts`)
2. Verify you're using the **server JAR**, not client JAR
3. For MC 1.18+, ensure `-DbundlerMainClass=net.minecraft.data.Main` is present
4. Check `registries.json` location (may be in `reports/` or `generated/reports/`)
5. Verify registry names use singular form (`block` not `blocks`)

### Handling New Minecraft Versions

The code should work automatically, but be aware:
- **MC 1.18+**: Requires bundler format and Java 17+
- **MC 1.21+**: May require Java 21+
- Registry output location may change between versions
- Always test with integration tests

## Error Handling, Security, and Performance Notes

- Network work uses retries/backoff; Java processes run with timeouts and stderr capture.
- Integrity checks: SHA-1/256 verification on downloads; cache rebuild on corruption.
- Security: path traversal guardrails on class names and file writes; Java processes memory-capped.
- Performance: favors lazy decompilation, parallel workers, and LRU-style cache eviction; compress/evict old versions if storage is tight.

## Reference Tools

- FabricMod-Remapper — exemplar for two-phase Yarn remapping strategy (official → intermediary → yarn).
- mojang2tiny — reference implementation for converting Mojang mappings to Tiny v2.
- tiny-remapper — upstream bytecode remapper we wrap; check changelog for behavior changes.

## Architecture Decisions

### Why Server JAR for Registries?
- Server JAR has built-in data generator (`--reports` flag)
- Client JAR doesn't include data generation tools
- Server JAR can run obfuscated (no remapping needed)

### Why Two-Step Remapping for Yarn?
- Yarn builds on Fabric's Intermediary mappings
- Intermediary provides stable names across versions
- This allows Yarn to update names without breaking between Minecraft versions

### Why VineFlower over Fernflower?
- Better Java 17+ support
- More accurate decompilation
- Better performance on large JARs
- Active maintenance

### Why Tiny v2 Format?
- Standard format for Fabric toolchain
- Supports multiple namespaces in one file
- Compact and efficient
- Well-supported by tools

### Patched MC JARs (Forge/NeoForge) — opaque version key, mojmap-only
For `decompile_minecraft_version` with `jarPath`, the `version` parameter is treated as an opaque cache-key string (convention: `<mc>-<loader>-<loaderVersion>`). No parsing — the same key flows unchanged through `getDecompiledPath`, the cache DB, the FTS5 index, and every downstream tool. This is why patched MC slots into the existing `decompiled/{version}/{mapping}/` layout with zero new code paths in search/index/compare.

Forge/NeoForge dev environments (1.17+) are **mojmap-exclusive** — yarn is a Fabric/Quilt mapping with no equivalent in the Forge ecosystem. The schema enforces `mapping === 'mojmap'` whenever `jarPath` is set. `find_mapping` does no special-casing for patched keys: callers wanting a vanilla mojmap↔yarn translation should pass the vanilla MC version directly.

### Sources-vs-compiled detection (`src/utils/jar-inspector.ts`)
Deterministic central-directory scan: any `.class` entry → decompile via VineFlower; else any `.java` → extract directly (NFRT/ForgeGradle `-sources.jar` fast path); else error. Mixed JARs always decompile (any `.class` wins). Avoids filename heuristics, which Forge/NeoForge dev artifacts don't reliably follow.

## Troubleshooting

### "Class not found" errors during registry extraction
→ Using client JAR instead of server JAR. Check `registry-service.ts`.

### Yarn remapping fails
→ Ensure two-step process is happening (official → intermediary → yarn).

### Decompilation creates folders in project directory
→ Expected VineFlower behavior. These folders are gitignored.

### Tests timeout
→ First run downloads ~50MB of JARs. Increase timeout or use cached versions.

### "Java version" errors
→ MC 1.18+ requires Java 17+, MC 1.21+ requires Java 21+.

## MCP Tools Reference

### Phase 1 Tools (Core)
1. **`get_minecraft_source`** - Get decompiled source for a Minecraft class
2. **`decompile_minecraft_version`** - Trigger full decompilation of a version. Pass `jarPath` to point at a local Forge/NeoForge **patched** MC JAR (cache key convention: `<mc>-<loader>-<loaderVersion>`, e.g. `1.21.1-neoforge-21.1.72`); in this mode `mapping` must be `'mojmap'` (Forge/NeoForge dev environments are mojmap-only post-1.17). Sources JARs (no `.class` entries) are extracted directly; compiled JARs run through VineFlower. `force: true` wipes the decompiled dir, the job row, and the FTS5 index for that (version, mapping).
3. **`list_minecraft_versions`** - List available and cached versions
4. **`get_registry_data`** - Get registry data (blocks, items, entities)

### Phase 2 Tools (Advanced Analysis)
5. **`remap_mod_jar`** - Loader-aware mod JAR remapping. Fabric/Quilt mods remap intermediary → `yarn`/`mojmap`/`feather`; Forge/NeoForge mods for 1.7.10–1.13.2 remap SRG member names → MCP (`toMapping: 'mcp'` is accepted for them as a no-op acknowledgement, and rejected with an actionable error for Fabric/Quilt mods). Both the loader and the Minecraft version auto-detect from mod metadata — including legacy `mcmod.info` `mcversion`, so a 1.12.2 mod needs no explicit `mcVersion`. Version ranges are parsed for their first concrete version (`extractConcreteVersion`), so `[1.16.5,1.17)` and `1.21.10 || 1.21.9` work.
6. **`find_mapping`** - Lookup symbol mappings between namespaces
7. **`search_minecraft_code`** - Regex search in decompiled source
8. **`compare_versions`** - Compare classes/registries between versions
9. **`analyze_mixin`** - Analyze and validate Mixin code
10. **`validate_access_widener`** - Validate access widener files
10a. **`validate_access_transformer`** - Validate Forge/NeoForge access transformer files (parses `.cfg`, checks signatures, flags record canonical-constructor widening, inner-class accessibility, **inherited members**, and conflicting modifiers — including **across files** via `extraFiles`; mojmap-only). Validates against the **remapped JAR's bytecode** (via the bundled ASM `bytecode-dumper`), not decompiled `.java` — decompiled source omits compiler-generated record members (canonical constructors, component accessors), so a source-based check false-flags them as missing (issue #12). Bytecode carries every member with its true access flags and erased descriptors (the same facts `javap` shows). Only needs the remapped JAR, which `decompile_minecraft_version` produces; per-class results are cached in a `remapped/{version}-{mapping}.bytecode.json` sidecar keyed by JAR signature. **Patched keys work too**: the patched flow does no remapping, so `decompileLocalJar` copies a *compiled* input JAR to `remapped/{version}-{mapping}.jar` — it already is that key's remapped JAR by definition — and every bytecode consumer then resolves a patched key exactly like a vanilla one. Patched *sources* JARs (NFRT/ForgeGradle `-sources.jar`) contain no bytecode and cannot be validated; the tool says so rather than telling you to decompile again. **Inherited members**: an AT only transforms the class it names, so a directive aimed at a member declared on a parent is silently inert — the validator resolves the full ancestor closure (`getClassBytecodeWithHierarchy`: transitive `superName` + interfaces, ancestors outside the JAR skipped) and reports the declaring class plus a paste-ready corrected directive. **Cross-file conflicts**: pass sibling ATs via `extraFiles` — every AT is applied together at build time, so conflicts across files fail the build like in-file ones; findings are restricted to those involving the file under validation, and the record-ctor note is suppressed when a sibling widens the constructor. **Legacy SRG ids**: under `mapping: 'mcp'` (1.7.10–1.13.2) entries that name members by SRG id (`field_71428_T`, `func_180495_p`) are resolved to MCP names through the `mcp_stable` CSVs before lookup (see "Legacy Access Transformers Use SRG Member Names"), so a real 1.7.10 AT file validates instead of reporting every entry missing.
11. **`compare_versions_detailed`** - AST-level version comparison
12. **`index_minecraft_version`** - Create full-text search index
13. **`search_indexed`** - Fast FTS5 search on indexed versions
14. **`get_documentation`** - Get documentation for a class
15. **`search_documentation`** - Search documentation

### Phase 3 Tools (Mod Analysis)
16. **`analyze_mod_jar`** - Analyze third-party mod JAR files of ANY loader era (Fabric/Quilt, Forge 1.13+/NeoForge `mods.toml`, legacy Forge `mcmod.info`); backfills from `MANIFEST.MF` and bytecode and reports undetermined facts in `warnings`
17. **`decompile_mod_jar`** - Decompile mod JARs to readable Java source. Auto-detects the mod id/version from metadata, `@Mod` bytecode and `MANIFEST.MF`; fails with instructions (rather than writing to `decompiled-mods/unknown/0.0.0/`) when the id/version cannot be determined
18. **`search_mod_code`** - Search decompiled mod source code
19. **`index_mod`** - Create full-text search index for mod source
20. **`search_mod_indexed`** - Fast FTS5 search on indexed mod source

#### `analyze_mod_jar` Tool

Analyzes a mod JAR file to extract comprehensive metadata. Every loader era is supported: Fabric/Quilt (`fabric.mod.json`/`quilt.mod.json`), Forge 1.13–1.20.x and NeoForge (`META-INF/mods.toml`/`neoforge.mods.toml`), and **legacy Forge 1.6.4–1.12.2 (`mcmod.info`)**.

**Input**:
```typescript
{
  jarPath: string;           // Local path to the mod JAR file
  includeAllClasses?: boolean; // Include full class list (can be large)
  includeRawMetadata?: boolean; // Include raw fabric.mod.json / mcmod.info / mods.toml / manifest / mixin configs
}
```

**Output** includes:
- **Mod metadata**: ID, version, name, description, authors, license
- **Compatibility**: Minecraft version, loader version, Java version, environment (client/server)
- **Dependencies**: Required, optional, incompatible mods with version constraints (Forge `mods.toml` dependency blocks are parsed with their ranges and `side`; legacy `requiredMods` are `required` and `dependencies`/`dependants` are `type: 'ordering'`)
- **Entry points**: Fabric initializers, or Forge `@Mod` classes plus legacy coremods/tweakers (`MANIFEST.MF` `FMLCorePlugin`/`TweakClass`)
- **Mixins**: Config files (loader metadata + `MANIFEST.MF` `MixinConfigs` + a `*.mixins.json` scan), packages, class lists, `minVersion`/`compatibilityLevel`/`refmap`
- **Access transformers**: Forge `FMLAT` / NeoForge `[[accessTransformers]]` / legacy `*_at.cfg`
- **Class analysis**: Total count, package breakdown, mixin detection and `mixinTargets` read from `@Mixin` bytecode
- **Warnings**: everything that could not be determined (missing metadata, a fallback id/version, `@Mod` vs metadata disagreement)
- **Nested JARs**: Jar-in-Jar dependencies

**Example usage** (for LLM):
```
analyze_mod_jar({ jarPath: "C:/mods/meteor-client-1.21.10-32.jar" })
```

Returns JSON with full mod analysis including detected loader type, all dependencies, entry points, and mixin configurations.

## Phase 3 Services

### `mod-analyzer-service.ts`

Analyzes third-party mod JARs without requiring Java. Performs:

1. **Loader Detection**: `fabric.mod.json`, `quilt.mod.json`, `META-INF/neoforge.mods.toml`, `META-INF/mods.toml`, root `mcmod.info`, `META-INF/fml_cache_annotation.json`, or an FML `MANIFEST.MF` (`FMLCorePlugin`/`TweakClass`)
2. **Metadata Parsing**: mod ID, version, dependencies, entry points and access transformers from the loader-specific file — see "Mod Metadata Is Loader-Era Specific" above
3. **Mixin Analysis**: config discovery from loader metadata + `MANIFEST.MF` `MixinConfigs` + a `*.mixins.json` scan; parses packages, class lists, `minVersion`, `compatibilityLevel`, `refmap`
4. **Bytecode Analysis** (`src/parsers/class-file.ts`, no JDK): `@Mod` ids, legacy coremod interfaces, `@Mixin` targets (from BOTH retention attributes), class shape, method/field counts
5. **Gap Reporting**: `warnings` names every fact that could not be determined, instead of substituting a placeholder

**Key types** (`src/types/minecraft.ts`):
- `ModLoader`: `'fabric' | 'quilt' | 'forge' | 'neoforge' | 'unknown'`
- `ModAnalysisResult`: Complete analysis output structure (incl. `warnings` and `accessTransformers`)
- `ModClass`: Class metadata including mixin detection and `mixinTargets`
- `ModMixinConfig`: Parsed mixin configuration
- `DependencyType`: includes `'ordering'` for legacy `mcmod.info` load-order constraints

### `mod-decompile-service.ts`

Decompiles mod JARs to readable Java source code. Supports both original (intermediary) and remapped JARs.

**Key features**:
1. **Auto-detection**: Mod ID and version from the loader metadata (Fabric/Quilt JSON, `mods.toml`, legacy `mcmod.info`), then `@Mod` bytecode, then `MANIFEST.MF` `Implementation-Version`. If neither can be determined the call FAILS with instructions instead of caching under `unknown/0.0.0` — one shared directory every unidentified mod would land in, so the next one would be handed the previous one's source.
2. **Caching**: Decompiled sources cached in `AppData/decompiled-mods/{modId}/{modVersion}/{mapping}/`
3. **Progress tracking**: Database-backed job tracking with progress updates
4. **VineFlower integration**: Reuses same decompiler as Minecraft decompilation
5. **WSL compatibility**: Full support for WSL and Windows path formats

**Workflow**:
1. `remap_mod_jar` - Loader-aware remap (Fabric: intermediary → yarn/mojmap/feather; Forge 1.7.10–1.13.2: SRG → MCP). Optional — skip it if the JAR is already readable.
2. `decompile_mod_jar` - Decompile JAR to readable Java source
3. `search_mod_code` OR `index_mod` + `search_mod_indexed` - Search through decompiled source

#### `decompile_mod_jar` Tool

Decompiles a mod JAR file to readable Java source code.

**Input**:
```typescript
{
  jarPath: string;      // Path to mod JAR (WSL or Windows path)
  mapping: 'yarn' | 'mojmap' | 'mcp' | 'feather';  // Mapping type the JAR uses (mcp for 1.7.10-1.13.2 Forge, feather for pre-1.7.10)
  modId?: string;       // Optional, auto-detected if not provided
  modVersion?: string;  // Optional, auto-detected if not provided
}
```

**Output**: Decompiled source directory path, mod ID, version, and any `warnings`

**Example**:
```
decompile_mod_jar({ jarPath: "C:/mods/meteor-remapped-yarn.jar", mapping: "yarn" })
```

#### `search_mod_code` Tool

Search for classes, methods, fields, or content in decompiled mod source code using regex patterns.

**Input**:
```typescript
{
  modId: string;
  modVersion: string;
  query: string;                    // Regex pattern or literal string
  searchType: 'class' | 'method' | 'field' | 'content' | 'all';
  mapping: 'yarn' | 'mojmap';
  limit?: number;                   // Default: 50
}
```

**Example**:
```
search_mod_code({ modId: "meteor-client", modVersion: "0.5.8", query: "onTick", searchType: "method", mapping: "yarn" })
```

#### `index_mod` Tool

Creates a full-text search index for decompiled mod source code using SQLite FTS5.

**Input**:
```typescript
{
  modId: string;
  modVersion: string;
  mapping: 'yarn' | 'mojmap';
  force?: boolean;  // Force re-indexing, default: false
}
```

**Benefits**: Enables much faster searching via `search_mod_indexed` tool

#### `search_mod_indexed` Tool

Fast full-text search using pre-built mod index. Supports FTS5 syntax.

**Input**:
```typescript
{
  query: string;  // FTS5 syntax: AND, OR, NOT, "phrase", prefix*
  modId: string;
  modVersion: string;
  mapping: 'yarn' | 'mojmap';
  types?: Array<'class' | 'method' | 'field'>;  // Optional filter
  limit?: number;  // Default: 100
}
```

**Example**:
```
search_mod_indexed({ query: "packet AND send", modId: "meteor-client", modVersion: "0.5.8", mapping: "yarn" })
```

## Mod Analysis Use Cases

The Phase 3 mod tools enable:
- **Compatibility analysis**: Understanding how other mods work for interop
- **Learning**: Studying mod development techniques from popular mods
- **Debugging**: Investigating mod interactions and conflicts
- **Educational reference**: Exploring Minecraft modding patterns
- **Code search**: Finding specific implementations across mod codebases
