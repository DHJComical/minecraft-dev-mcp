# Tools Reference

21 tools organized by category. Mapping channels cover every Minecraft version from alpha 1.0.10 (Ornithe feather/calamus) through 1.13.2 (Forge MCP) to 26.1+ (unobfuscated) — see the README's [Version Support](../README.md#version-support) table.

## Source Code (6 tools)

Decompile, browse, and search Minecraft source code.

| Tool | Description | Parameters |
| --- | --- | --- |
| **list_minecraft_versions** | List all versions available from Mojang and which are already cached locally. | None |
| **decompile_minecraft_version** | Decompile an entire Minecraft version. Downloads the client JAR, remaps it, and decompiles all classes with VineFlower. Subsequent calls use cached results. Also accepts a `jarPath` for Forge/NeoForge patched JARs (version key `<mc>-<loader>-<loaderVersion>`). | `version`, `mapping` • Optional: `force` (re-decompile), `jarPath` |
| **get_minecraft_source** | Get decompiled Java source for a specific Minecraft class. Downloads, remaps, and decompiles automatically on first use; subsequent requests are instant from cache. | `version`, `className`, `mapping` (`yarn`\|`mojmap`\|`mcp`\|`feather`) • Optional: `startLine`, `endLine`, `maxLines` |
| **search_minecraft_code** | Regex search across decompiled Minecraft source by class name, method name, field name, or file content. | `version`, `query`, `searchType` (`class`\|`method`\|`field`\|`content`\|`all`), `mapping` • Optional: `limit` |
| **index_minecraft_version** | Build a SQLite FTS5 full-text search index for decompiled Minecraft source. Required before using `search_indexed`. | `version`, `mapping` |
| **search_indexed** | Fast full-text search on a pre-built index using FTS5 syntax. Significantly faster than `search_minecraft_code` for broad queries. Supports AND, OR, NOT, phrase matching, and prefix wildcards. | `query`, `version`, `mapping` • Optional: `types` (`class`\|`method`\|`field`), `limit` |

## Mappings & Registry (3 tools)

Translate names between namespaces and explore game data.

| Tool | Description | Parameters |
| --- | --- | --- |
| **find_mapping** | Translate a class, method, or field name between any two mapping namespaces (official, intermediary, yarn, mojmap, mcp, calamus, feather). | `symbol`, `version`, `sourceMapping`, `targetMapping` |
| **remap_mod_jar** | Remap a mod JAR to human-readable names, loader-aware: Fabric/Quilt mods (intermediary → yarn/mojmap/feather) and Forge/NeoForge mods for 1.7.10–1.13.2 (SRG member names → MCP; pass `toMapping: "mcp"` for those, it is a no-op acknowledgement). Accepts WSL and Windows paths. Loader and Minecraft version are auto-detected from mod metadata if not provided — including legacy Forge `mcmod.info` `mcversion`. | `inputJar`, `outputJar`, `toMapping` (`yarn`\|`mojmap`\|`feather`\|`mcp`) • Optional: `mcVersion`, `loader` (`auto`\|`fabric`\|`quilt`\|`forge`\|`neoforge`) |
| **get_registry_data** | Extract registry data (blocks, items, entities, etc.) for a version by running Minecraft's built-in data generator. | `version` • Optional: `registry` (e.g., `block`, `item`, `entity`) |

## Analysis & Validation (7 tools)

Compare versions, validate mod code, and browse documentation.

| Tool | Description | Parameters |
| --- | --- | --- |
| **compare_versions** | Compare two Minecraft versions to identify added and removed classes and registry entries. | `fromVersion`, `toVersion`, `mapping` • Optional: `category` (`classes`\|`registry`\|`all`) |
| **compare_versions_detailed** | AST-level version comparison showing exact method signature changes, field type changes, and breaking API modifications. Can be scoped to specific packages. | `fromVersion`, `toVersion`, `mapping` • Optional: `packages`, `maxClasses` |
| **analyze_mixin** | Parse and validate Mixin code against Minecraft source. Validates target classes, injection methods, and annotation syntax. Provides similarity suggestions on failures. | `source` (Java code or file path), `mcVersion` • Optional: `mapping` |
| **validate_access_widener** | Validate a Fabric Access Widener file against Minecraft source. Checks all class, method, and field targets exist and flags invalid entries. | `content` (file content or path), `mcVersion` • Optional: `mapping` |
| **validate_access_transformer** | Validate a Forge/NeoForge Access Transformer (`.cfg`) file against Minecraft source. Checks that targets exist and match signatures, detects record canonical-constructor crashes, inner-class accessibility issues, and conflicting modifiers. Forge/NeoForge dev environments are mojmap-only. Under `mapping: "mcp"` (1.7.10–1.13.2) legacy **SRG member ids** (`field_71428_T`, `func_180495_p`) are resolved to MCP names before lookup, exactly as the loader does — without that, every entry in a pre-1.17 AT file reports "not found". | `content` (file content or path), `mcVersion` • Optional: `mapping` (default `mojmap`), `extraFiles` |
| **get_documentation** | Get documentation links and usage hints for a Minecraft or Fabric class. Links to Fabric Wiki and Minecraft Wiki. | `className` |
| **search_documentation** | Search across all known Minecraft and Fabric documentation topics. | `query` |

## Mod Analysis (5 tools)

Analyze and decompile third-party mod JARs.

| Tool | Description | Parameters |
| --- | --- | --- |
| **analyze_mod_jar** | Analyze a third-party mod JAR without decompiling. Extracts mod ID, version, Minecraft compatibility, dependencies, entry points, mixin configs, access transformers, and class statistics — with mixin targets read from `@Mixin` bytecode. Every loader era is supported: Fabric/Quilt (`fabric.mod.json`), Forge 1.13–1.20.x and NeoForge (`mods.toml` / `neoforge.mods.toml`, dependencies included), and **legacy Forge 1.6.4–1.12.2 (`mcmod.info`)**. Facts the metadata files omit are recovered from `META-INF/MANIFEST.MF` (`MixinConfigs`, `FMLAT`, `FMLCorePlugin`, `TweakClass`, `Implementation-Version`) and from bytecode (`@Mod` ids, coremod interfaces). Anything that could not be determined is reported in `warnings` rather than guessed. | `jarPath` • Optional: `includeAllClasses`, `includeRawMetadata` |
| **decompile_mod_jar** | Decompile a mod JAR to readable Java source. Accepts original (intermediary) or remapped JARs. Mod ID and version are auto-detected from metadata — including legacy `mcmod.info`, `@Mod` bytecode and `MANIFEST.MF`. If neither can be determined, the tool fails with instructions instead of caching the mod under a shared placeholder directory. | `jarPath`, `mapping` • Optional: `modId`, `modVersion` |
| **search_mod_code** | Regex search in decompiled mod source by class, method, field, or content. | `modId`, `modVersion`, `query`, `searchType`, `mapping` • Optional: `limit` |
| **index_mod** | Build a SQLite FTS5 full-text search index for decompiled mod source. Required before using `search_mod_indexed`. | `modId`, `modVersion`, `mapping` • Optional: `force` |
| **search_mod_indexed** | Fast FTS5 search on a pre-built mod index. Supports AND, OR, NOT, phrase matching, and prefix wildcards. | `query`, `modId`, `modVersion`, `mapping` • Optional: `types`, `limit` |
