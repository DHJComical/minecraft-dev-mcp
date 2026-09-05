# Manual Version And Transport Tests

This directory contains long-running tests that are intentionally excluded from default CI.

It now includes two categories:
- Service-level version compatibility suites (`v1.21.10`, `v1.20.1`, `v1.19.4`, `mojmap`)
- True MCP transport E2E suite (`mcp/`) that starts the stdio server and validates tool calls through an MCP client

## Why Manual Tests Exist

- CI performance: default PR CI runs a focused suite
- Legacy coverage: older versions still need real validation
- Mapping coverage: Yarn and Mojmap behavior differ by version
- Transport coverage: stdio MCP integration tests are heavier than direct handler tests

## Directory Structure

```text
manual/
  mcp/                # stdio MCP server E2E matrix tests
    stdio-matrix.test.ts
    test-constants.ts
  v1.21.10/           # Yarn pipeline tests
    test-constants.ts
    full-suite.test.ts
  v1.20.1/            # Yarn pipeline tests
    test-constants.ts
    full-suite.test.ts
  v1.19.4/            # Yarn pipeline tests
    test-constants.ts
    full-suite.test.ts
  v1.12.2/            # MCP (ModCoderPack) pipeline tests
    test-constants.ts
    full-suite.test.ts
  v1.13.2/            # MCP pipeline tests via MCPConfig joined.tsrg
    test-constants.ts
    full-suite.test.ts
  v1.7.10/            # MCP pipeline tests (oldest supported version)
    test-constants.ts
    full-suite.test.ts
  mojmap/             # Mojmap remap/decompile tests
    test-constants.ts
    mojmap-remapping.test.ts
```

## Run Commands

Run all manual tests:
```bash
npm run test:manual
```

Run MCP transport matrix only:
```bash
npm run test:manual:mcp
```

Run MCP transport quick smoke matrix:
```bash
npm run test:manual:mcp:smoke
```

Run specific service-level suites:
```bash
npm run test:manual:1.21.10
npm run test:manual:1.20.1
npm run test:manual:1.19.4
npm run test:manual:1.12.2
npm run test:manual:1.7.10
npm run test:manual:1.13.2
npm run test:manual:mojmap
```

Run specific Mojmap version:
```bash
npm run test:manual:mojmap:1.21.11
npm run test:manual:mojmap:1.21.10
npm run test:manual:mojmap:1.20.1
npm run test:manual:mojmap:1.19.4
```

Run everything (default + manual):
```bash
npm run test:all
```

## MCP Matrix Version Selection

`__tests__/manual/mcp/stdio-matrix.test.ts` supports `MCP_E2E_VERSIONS`.

Example:
```bash
cross-env MCP_E2E_VERSIONS=1.21.11,1.20.1,26.1-snapshot-1,26.1-snapshot-9 npm run test:manual:mcp
```

Versions are classified at runtime using Mojang metadata via
`VersionManager.isVersionUnobfuscated()`, not by hardcoded version-id patterns.

Default matrix includes:
- `1.21.11`
- `1.21.10`
- `1.20.1`
- `1.19.4`
- `26.1-snapshot-1` (first unobfuscated boundary)
- `26.1-snapshot-8` (mid-series unobfuscated check)
- `26.1-snapshot-9` (latest unobfuscated snapshot)

## Version Support Notes

- `1.21.11` and below: obfuscated client, Yarn and Mojmap remap paths apply
- `1.12.2`, `1.7.10`: obfuscated client, MCP (ModCoderPack) remap path
  applies (single-step obf->SRG with `ignoreFieldDesc`); registry extraction
  is unsupported (<1.13) and must fail with a clear error
- `1.13.2`: obfuscated client, MCP via MCPConfig `joined.tsrg` (no yarn,
  no official mappings for this era); registry boundary version
- `26.1+` snapshots: unobfuscated client, use `mojmap` path, Yarn should fail with actionable guidance
