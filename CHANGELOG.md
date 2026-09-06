# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] - 2026-09-06

Agent discoverability release: teach agents when to call the server, and fix
the mapping enums that made pre-1.14 versions look unsupported.

### Added

- **Server instructions** (`src/index.ts`): the MCP server now sends global
  `instructions` telling agents to verify Minecraft internals against the real
  decompiled source for the exact version (instead of training knowledge),
  with per-task tool routing and default mappings per era (yarn 1.14–1.21.11,
  mojmap 26.1+, mcp 1.7.10–1.13.2, feather pre-1.7.10).
- **Trigger-first tool descriptions**: all 21 tool descriptions now open with
  "When the user asks about X, use this", so agents route user questions
  (class behavior, obfuscated names, registries, version diffs, mod contents,
  mixin/AW/AT validation) to the right tool.
- **Bundled agent skill** (`skills/minecraft-dev/`): now shipped in the npm
  package (`files` includes `skills/`) with install docs in the README for
  Claude Code, Cursor, Codex CLI, and OpenCode — agents without MCP can call
  `minecraft-dev-cli` instead.
- **Multi-client MCP setup docs** (README): copy-paste configs for Cursor,
  VS Code (`.vscode/mcp.json` `servers` shape), Codex CLI (`config.toml`),
  Windsurf, and Gemini CLI, plus the global-install `PATH` note.

### Fixed

- **Mapping enums widened to `yarn`/`mojmap`/`mcp`/`feather`** on 14 tools
  (`search_minecraft_code`, `compare_versions`, `analyze_mixin`,
  `validate_access_widener`, `validate_access_transformer`,
  `compare_versions_detailed`, `index_minecraft_version`, `search_indexed`,
  `decompile_mod_jar`, `search_mod_code`, `index_mod`,
  `search_mod_indexed`, plus the zod schemas and the
  `minecraft://source`/`minecraft://index` resource validators). The backends
  always supported mcp/feather — only the exposed schemas claimed
  `yarn`/`mojmap`, so agents concluded pre-1.14 versions were unsupported and
  had no valid mapping to pass for e.g. 1.12.2 (which needs `mcp`, as it has
  no mojmap). Each mapping description now also states its version era.

## [1.6.1] - 2026-09-06

Documentation-only release: 1.6.0 shipped with the README frozen before the
docs refresh, so the npm page showed the pre-1.7.10-era version support
table. The published code itself is identical to 1.6.0.

### Changed

- **README** (`README.md`): the Version Support table now covers every era —
  alpha 1.0.10–1.6.4 (Ornithe feather/calamus), 1.7.10–1.13.2 (Forge MCP),
  1.14–1.21.11 (yarn/mojmap), 26.1+ (unobfuscated) — plus the explicit
  not-supported list (1.10.1, pre-alpha), updated tested-versions list,
  loader-aware mod remapping in the feature table, Ornithe in the credits,
  and feather guidance in troubleshooting.
- **docs/tools.md**: mapping enums for `get_minecraft_source`/`find_mapping`,
  the loader-aware `remap_mod_jar` signature, and `decompile_minecraft_version`'s
  patched-JAR `jarPath` flow.

## [1.6.0] - 2026-09-06

### Added

- **Minecraft pre-1.7.10 support via Ornithe (feather/calamus)** — the
  version floor drops from 1.7.10 to **alpha 1.0.10**, covering every beta
  (b1.0–b1.8.1) and release (1.0–1.6.4) version in between. Those eras have
  no Mojang official mappings (1.14.4+), no Fabric yarn/intermediary (1.14+)
  and no MCP CSV artifacts (mcp_stable starts at 1.7.10); the readable-names
  channel is Ornithe's `calamus-intermediary` (obf → intermediary) and
  `feather` (intermediary → named) from maven.ornithemc.net, both tiny v2.
  Remapping is two-step (official → calamus → feather), mirroring yarn; the
  split `-client`/`-server` calamus artifacts used before MC 1.3 are probed
  automatically (the client JAR is always the decompile target).
- **New mapping types**: `feather` (Ornithe human-readable names for
  pre-1.7.10) and `calamus` (Ornithe intermediary), usable everywhere a
  mapping type is accepted, including `find_mapping` (official ↔ feather
  lookups bridge through calamus) and the `mcp://mappings/...` resources.
- **Loader-aware `remap_mod_jar`.** Forge/NeoForge mods for 1.7.10–1.13.2
  (distributed with SRG member names and unchanged class names) can now be
  remapped to MCP names: a member-only SRG→MCP mapping is built from the same
  Forge maven artifacts, and the SRG-named vanilla JAR is passed to
  tiny-remapper as a classpath so inheritance is resolved correctly. The
  loader is auto-detected from mod metadata (`fabric.mod.json` / `mods.toml`
  / `mcmod.info`) or set explicitly via the new `loader` parameter. Fabric
  mods targeting pre-1.7.10 versions can remap to `feather`. (Forge mods for
  1.14+ are not supported — no published SRG→member mappings exist for those
  eras.)
- **Manual test suite for b1.7.3** (`npm run test:manual:b1.7.3`) covering
  download → calamus/feather build → two-step remap → decompile → source
  retrieval, plus the registry fail-fast for non-1.x version ids.

## [1.5.1] - 2026-09-05

### Added

- **MCP mappings now cover every version from 1.7.10 through 1.13.2**
  (previously only 1.12.2). The stable-build table in the MCP downloader was
  rewritten with values verified against
  `de/oceanlabs/mcp/mcp_stable/maven-metadata.xml` on maven.minecraftforge.net —
  the old entries for 1.8–1.11 pointed at artifacts that do not exist (HTTP 404).
  Patch releases without their own stable CSV artifact (1.9.2, 1.10, 1.11.1)
  alias the nearest stable build, which is safe because MCP SRG ids
  (`field_`/`func_NNNNN`) are globally permanent; unmapped ids fall back to
  their SRG name in the joined output.
- **Minecraft 1.13.x support via MCPConfig** (`de.oceanlabs.mcp:mcp_config`).
  1.13–1.13.2 have no Mojang official mappings (1.14.4+), no Fabric
  yarn/intermediary (1.14+), and the plain `mcp:<v>:srg` zips stop at 1.12.x.
  Mappings are reconstructed from `config/joined.tsrg` (tsrg v1) joined with
  the `mcp_stable` CSVs — the same route Unimined/ForgeGradle 3 take. A new
  `tsrgToSrg` converter feeds the existing join/remap pipeline unchanged.
- **Minecraft 1.14.0–1.14.3 verified end-to-end through the existing yarn
  path** (no code changes needed; documented and covered by smoke runs).
- **Manual test suites for 1.7.10 and 1.13.2**
  (`npm run test:manual:1.7.10`, `npm run test:manual:1.13.2`) covering
  download → mapping build → remap → decompile → source retrieval, plus the
  clear `get_registry_data` failure for <1.13.
- **Offline unit tests** for the MCP mapping utilities (`__tests__/core/mcp-mappings.test.ts`),
  replicating the real artifact formats of 1.7.10–1.13.2 (`PK:` lines,
  descriptor-less `FD:` lines, synthetic `$VALUES`, pre-named enum constants,
  tsrg v1 layout, tsrg v2 rejection).

### Fixed

- **`find_mapping` field lookups for `mcp` silently returned misses.**
  The generated obf → MCP SRG places `FD:` lines before any `CL:` line (a
  mapping-io `detectFormat` workaround), but `lookupInMcpSrg` parsed members
  by attaching them to the preceding `CL:` entry, so every `FD:` line was
  skipped. Parsing is now order-independent: `FD:`/`MD:` lines carry the class
  name explicitly on both sides and are keyed by their own line.

### Changed

- Tool descriptions now advertise `mcp` as "pre-1.14.4 versions
  (1.7.10-1.13.2)" instead of citing 1.12.2 only.
- 1.10.1 remains unsupported: it has no `mcp-<v>-srg.zip` on the Forge maven
  at all; requests fail fast with the list of supported versions.

## [1.4.1] - 2026-09-05

Corrects the package metadata published with 1.4.0 (repository/homepage/bugs
now point at the publishing fork `DHJComical/minecraft-dev-mcp` instead of the
upstream `MCDxAI` repository). No functional changes.

## [1.4.0] - 2026-09-05

First release under the `@dhjcomical` scope (the same codebase as
`@mcdxai/minecraft-dev-mcp@1.3.0`, plus Minecraft 1.12.2 support).

### Added

- **Minecraft 1.12.2 support via MCP mappings.** 1.12.2 predates Mojang's
  official mappings (`client_mappings` only exist from 1.14.4) and Fabric's
  yarn/intermediary (1.14+), so it uses the Forge ModCoderPack (MCP) mappings,
  reconstructed at build time from two public Forge maven artifacts:
  `de.oceanlabs.mcp:mcp:1.12.2:srg` (`joined.srg`, obfuscated → SRG) and
  `de.oceanlabs.mcp:mcp_stable:39-1.12` (`fields.csv`/`methods.csv`,
  SRG → MCP names). The combined obf → MCP SRG is consumed by tiny-remapper
  with `ignoreFieldDesc` (SRG `FD:` lines carry no descriptors).
- **New `mcp` mapping type** for `MappingType`, usable with
  `decompile_minecraft_version`, `get_minecraft_source`, `search_minecraft_code`,
  `index_minecraft_version`, `search_indexed`, `compare_versions`,
  `compare_versions_detailed`, `find_mapping`, and the HTTP resources.
- **`find_mapping` supports MCP** in both directions (obfuscated ↔ MCP names).
- **Manual test suite** for 1.12.2 (`npm run test:manual:1.12.2`).

### Changed

- **Registry extraction is explicitly unsupported for <1.13.** Versions like
  1.12.2 have no bundled data generator (`net.minecraft.data.Main` /
  `--reports` were introduced in 1.13); `get_registry_data` now throws a clear,
  actionable error instead of failing obscurely inside the Java process.

## [Unreleased]

### Fixed

- **Flaky cross-file AT conflict test on a cold CI cache.** The tool-level test
  for `extraFiles` conflict detection asserted the conflict *finding* through
  `handleValidateAccessTransformer`, which reaches conflict detection only after
  `validateAccessTransformer` clears its remapped-JAR guard. ATs default to
  `mojmap`, but CI only pre-decompiles `1.21.11/yarn` — the mojmap remap happens
  as a side effect of another suite running in parallel, so on a cold cache the
  assertion raced it and failed. It passed otherwise only because the
  yarn-keyed cache incidentally carries the mojmap JAR. The conflict findings
  (cross-file naming, duplicates, `restrictTo` scoping) now assert against the
  pure `detectAccessTransformerConflicts`, with entries parsed exactly as the
  handler parses them; the tool test keeps the bytecode-independent plumbing
  assertions. No production code changed.

## [1.3.0] - 2026-08-06

Completes the access transformer work tracked in
[#12](https://github.com/MCDxAI/minecraft-dev-mcp/issues/12). Version 1.2.5 was
bumped in the repository but never tagged or published; its changes ship here.

### Added

- **Inherited-member detection for access transformers.** An AT only transforms
  the class it names, so a directive aimed at a member declared on a parent is
  silently inert — the build passes, the game loads, the member stays
  inaccessible. `validate_access_transformer` now resolves the full ancestor
  closure (transitive `superName` + interfaces, ancestors outside the JAR
  skipped) and reports the declaring class along with a paste-ready corrected
  directive. Constructors are excluded, since they are never inherited.
- **Inherited-member detection for access wideners.** Fabric AWs have identical
  semantics: `AccessWidenerClassVisitor` resolves `EntryTriple(className, name,
  descriptor)` through a plain `HashMap.getOrDefault` with no hierarchy walk, so
  an AW naming a subclass for an inherited member widens nothing. Both
  validators share the walk in `src/utils/bytecode-hierarchy.ts` so they cannot
  drift on a rule they both have.
- **Cross-file AT conflict detection** via a new optional `extraFiles` parameter
  on `validate_access_transformer`. Every AT a mod ships is applied together at
  build time, so a conflict spanning two files fails the Forge build exactly
  like one inside a single file. Duplicates and conflicts name both files and
  both lines; findings are restricted to those involving the file under
  validation. Unresolvable paths are reported as `extraFilesNotFound` rather
  than silently dropped.
- **Comma-separated and repeated array flags in the CLI.** Both
  `--extraFiles a.cfg,b.cfg` and `--extraFiles a.cfg --extraFiles b.cfg` now
  work; JSON (`--extraFiles '["a.cfg","b.cfg"]'`) still parses. Non-array flags
  keep last-wins semantics.

### Changed

- **Access transformers and access wideners validate against bytecode, not
  decompiled `.java`.** Decompiled source omits compiler-generated record
  members (canonical constructors, component accessors), which made the
  validators report them as missing — the false positives reported in #12.
  Bytecode carries every member with its true access flags and erased
  descriptors. Per-class results are cached in a
  `remapped/{version}-{mapping}.bytecode.json` sidecar keyed by JAR signature.
- **Record canonical-constructor widening is informational, not an error.**
  Widening the constructor is only required if you instantiate the record;
  reading its components is fine without it. The note is suppressed entirely
  when a sibling AT passed via `extraFiles` widens the constructor.
- **Compact, verdict-first tool output** for `validate_access_transformer`.
- **Access widener class names stay in slash notation.** The parser normalized
  to dots, so suggestions came out as `a.b.C` — which Fabric's reader rejects
  outright (*"Class-names must be specified as a/b/C, not a.b.C"*), meaning a
  pasted suggestion would break the build. The token is now preserved as
  written; lookups already normalized either form via `toInternalName()`.
- The inheritance check runs before the descriptor-mismatch branch, so a class
  declaring `tick(I)V` when the AT asks for `tick()V` is reported as an
  inheritance problem rather than a bad descriptor.

### Fixed

- **Access transformer and widener validation on patched Forge/NeoForge keys.**
  The patched flow does no remapping, so `decompileLocalJar` now copies a
  compiled input JAR to `remapped/{version}-{mapping}.jar` — by definition
  already that key's remapped JAR — letting every bytecode consumer resolve a
  patched key exactly like a vanilla one. Patched *sources* JARs (NFRT /
  ForgeGradle `-sources.jar`) contain no bytecode and cannot be validated; the
  tool now says so instead of telling you to decompile again.
- Hardened the bytecode index cache against concurrent access.

### Internal

- CI builds the committed `bytecode-dumper` JAR and re-runs tests when it
  changes, so the bytecode-gated suites actually execute instead of skipping.
- Lint is enforced in CI; pre-existing Biome findings fixed.
- LF line endings enforced via `.gitattributes`.

## [1.2.4] - 2026-07-06

### Fixed

- Bundled Java tool JARs were missing from the npm package, which broke
  decompilation, source lookup, and the validation tools for npm consumers.

## [1.2.3] - 2026-07-06

### Fixed

- Swapped the `tree-sitter` dependency for the `@keqingmoe/tree-sitter` fork,
  which ships prebuilt binaries for x64 and arm64 on macOS, Linux, and Windows.
  This fixes install failures on arm64, where upstream tree-sitter ships no
  prebuilt binaries.

### Documentation

- Documented the `validate_access_transformer` tool in the README, tools
  reference, and Minecraft dev skill.

## [1.2.2] - 2026-07-02

### Added

- `validate_access_transformer` tool for Forge/NeoForge `.cfg` files
  ([#12](https://github.com/MCDxAI/minecraft-dev-mcp/issues/12)).
- Agent skill for the standalone CLI
  ([#13](https://github.com/MCDxAI/minecraft-dev-mcp/pull/13)).

### Changed

- Java parsing moved to tree-sitter AST + ASM bytecode
  ([#14](https://github.com/MCDxAI/minecraft-dev-mcp/pull/14)).

### Internal

- CI caches the decompiled Minecraft tree in the test workflow.

## [1.2.1] - 2026-06-29

### Fixed

- **`search_indexed` returned incomplete or incorrect results**
  ([#11](https://github.com/MCDxAI/minecraft-dev-mcp/issues/11)). The line-based
  regex symbol extractor dropped roughly 31% of method declarations (qualified,
  generic, and annotated return types; constructors; multi-declarator fields)
  and mis-attributed methods from anonymous classes to their enclosing class. It
  is replaced with a tree-sitter Java AST parser, so `search_indexed` now
  matches `search_minecraft_code`. **Re-index affected versions**
  (`index_minecraft_version` with `force: true`) to pick up the corrected index.
- **CLI produced no output on symlinked Node installs.** On nvm-windows (the
  `C:\nvm4w\nodejs` junction) or `npm link`, every `minecraft-dev-cli` command
  exited 0 with no output: the main-module guard compared `import.meta.url`
  (resolved to the realpath) against `process.argv[1]` (which keeps the symlink
  path), so `main()` never ran. The CLI now resolves the symlink first.

## [1.2.0] - 2026-06-10

### Added

- HTTP transport and a standalone CLI
  ([#10](https://github.com/MCDxAI/minecraft-dev-mcp/pull/10)).
- Support for local Forge/NeoForge patched Minecraft JARs via `jarPath` on
  `decompile_minecraft_version`
  ([#9](https://github.com/MCDxAI/minecraft-dev-mcp/pull/9)).

## [1.1.0] - 2026-03-28

### Fixed

- Unobfuscated-version awareness in `MappingService`, for Minecraft 26.1+
  ([#5](https://github.com/MCDxAI/minecraft-dev-mcp/pull/5),
  [#7](https://github.com/MCDxAI/minecraft-dev-mcp/pull/7)).
- Java executable resolution now uses `JAVA_HOME`, falling back to `java`
  ([#6](https://github.com/MCDxAI/minecraft-dev-mcp/pull/6)).

## [1.0.0] - 2025-12-19

Initial public release.

### Added

- MCP server exposing decompiled Minecraft source, registry data, and modding
  tools, plus Phase 3 third-party mod analysis (analyze, decompile, search,
  index).
- Yarn, Mojmap, and Intermediary mapping support, including the two-step Yarn
  remap (official → intermediary → named).
- Registry extraction via the server JAR's built-in data generator.

[Unreleased]: https://github.com/MCDxAI/minecraft-dev-mcp/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/MCDxAI/minecraft-dev-mcp/compare/v1.2.4...v1.3.0
[1.2.4]: https://github.com/MCDxAI/minecraft-dev-mcp/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/MCDxAI/minecraft-dev-mcp/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/MCDxAI/minecraft-dev-mcp/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/MCDxAI/minecraft-dev-mcp/compare/88fdadd...v1.2.1
[1.2.0]: https://github.com/MCDxAI/minecraft-dev-mcp/compare/84171e1...88fdadd
[1.1.0]: https://github.com/MCDxAI/minecraft-dev-mcp/compare/dae7dcc...84171e1
[1.0.0]: https://github.com/MCDxAI/minecraft-dev-mcp/commits/dae7dcc
