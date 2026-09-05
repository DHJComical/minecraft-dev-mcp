import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MappingNotFoundError } from '../utils/errors.js';
import { ensureDir } from '../utils/file-utils.js';
import { logger } from '../utils/logger.js';
import { buildJoinedMapping, tsrgToSrg, zipGetEntry } from '../utils/mcp-mappings.js';
import { getMcpConfigZipPath, getMcpJoinedSrgPath, getMcpSrgPath, paths } from '../utils/paths.js';
import { downloadFile } from './http-client.js';

/**
 * Downloader for MCP (ModCoderPack) mappings used by pre-1.14.4 Minecraft
 * versions (1.7.10 through 1.13.2), where Mojang does not publish official
 * mappings and Fabric's yarn/intermediary start at 1.14.
 *
 * Two artifact generations on maven.minecraftforge.net:
 * - 1.7.10–1.12.2: `de.oceanlabs.mcp:mcp:<version>:srg` → ZIP with
 *   `joined.srg` (obfuscated → SRG, methods carry full descriptors, field
 *   lines none)
 * - 1.13–1.13.2: `de.oceanlabs.mcp:mcp_config:<version>` → ZIP with
 *   `config/joined.tsrg` (tsrg v1, converted to SRG by `tsrgToSrg`); the
 *   route Unimined/ForgeGradle 3 take
 * - both eras: `de.oceanlabs.mcp:mcp_stable:<build>-<version>` → ZIP with
 *   `fields.csv`/`methods.csv`/`params.csv` (SRG → MCP names)
 *
 * The generated artifact is an obfuscated → MCP SRG file (`mcp-<version>.srg`)
 * which tiny-remapper can consume directly (with `ignoreFieldDesc`).
 */

const FORGE_MAVEN_BASE = 'https://maven.minecraftforge.net';
const MCP_MAVEN_BASE = 'https://files.minecraftforge.net/maven';

/**
 * Latest MCP stable build per Minecraft version, verified against
 * `https://maven.minecraftforge.net/de/oceanlabs/mcp/mcp_stable/maven-metadata.xml`.
 * Covers every release from 1.7.10 (the first version MCP published on the
 * Forge maven) through 1.12.2.
 *
 * Versions without artifacts of their own (1.9.2, 1.10, 1.11.1) alias the
 * nearest stable release: MCP SRG ids (field_/func_NNNNN) are globally
 * permanent — an id never changes meaning between versions — so unknown ids
 * merely fall back to their SRG name in the joined output. (1.10.1 has no
 * `mcp-<v>-srg.zip` on the maven at all and stays unsupported.)
 */
const MCP_STABLE_BUILD: Record<string, string> = {
  '1.12.2': '39-1.12',
  '1.12.1': '39-1.12',
  '1.12': '39-1.12',
  '1.11.2': '32-1.11',
  '1.11.1': '32-1.11',
  '1.11': '32-1.11',
  '1.10.2': '29-1.10.2',
  '1.10': '29-1.10.2',
  '1.9.4': '26-1.9.4',
  '1.9.2': '26-1.9.4',
  '1.9': '24-1.9',
  '1.8.9': '22-1.8.9',
  '1.8.8': '20-1.8.8',
  '1.8': '18-1.8',
  '1.7.10': '12-1.7.10',
};

/**
 * MC 1.13.x uses the newer MCPConfig distribution (`de.oceanlabs.mcp:mcp_config:<version>`,
 * which carries `config/joined.tsrg`) because the plain `mcp:<v>:srg` zips stop
 * at 1.12.x and Fabric yarn/intermediary do not cover 1.13.x at all. This is
 * the same route Unimined/ForgeGradle 3 take. Values are the latest verified
 * `mcp_stable` build providing fields.csv/methods.csv (1.13.1 has none of its
 * own and aliases 1.13.2 — MCP SRG ids are globally permanent).
 */
const MCP_CONFIG_VERSIONS: Record<string, string> = {
  '1.13.2': '47-1.13.2',
  '1.13.1': '47-1.13.2',
  '1.13': '43-1.13',
};

/**
 * Download and build the obfuscated → MCP SRG mapping for a version.
 * Returns the path to the generated `mcp-<version>.srg`.
 */
export async function downloadMcpMappings(version: string): Promise<string> {
  const outputPath = getMcpSrgPath(version);
  if (existsSync(outputPath)) {
    logger.info(`Using cached MCP mappings: ${outputPath}`);
    return outputPath;
  }

  const mcVersion = resolveMcVersion(version);
  const mcpConfigStable = MCP_CONFIG_VERSIONS[mcVersion];
  const buildKey = mcpConfigStable ?? MCP_STABLE_BUILD[mcVersion];
  if (!buildKey) {
    throw new MappingNotFoundError(
      version,
      'mcp',
      `No MCP stable mappings known for Minecraft ${mcVersion}; ` +
        `supported: ${Object.keys({ ...MCP_STABLE_BUILD, ...MCP_CONFIG_VERSIONS }).join(', ')}`,
    );
  }

  // 1. joined.srg / joined.tsrg (obfuscated → SRG)
  let joinedSrg: string;
  if (mcpConfigStable) {
    // 1.13.x: joined.tsrg inside the mcp_config zip (tsrg v1, tab-indented).
    const mcpConfigZipPath = getMcpConfigZipPath(version);
    const mcpConfigUrl = `${FORGE_MAVEN_BASE}/de/oceanlabs/mcp/mcp_config/${mcVersion}/mcp_config-${mcVersion}.zip`;
    if (!existsSync(mcpConfigZipPath)) {
      ensureDir(dirname(mcpConfigZipPath));
      try {
        await downloadFile(mcpConfigUrl, mcpConfigZipPath);
      } catch (error) {
        throw new MappingNotFoundError(
          version,
          'mcp',
          `Failed to download MCPConfig from ${mcpConfigUrl}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      logger.info(`Using cached MCPConfig zip: ${mcpConfigZipPath}`);
    }
    const joinedTsrgBuffer = readZipEntry(mcpConfigZipPath, 'config/joined.tsrg');
    if (!joinedTsrgBuffer) {
      throw new MappingNotFoundError(
        version,
        'mcp',
        `config/joined.tsrg not found in ${mcpConfigZipPath}`,
      );
    }
    joinedSrg = tsrgToSrg(new TextDecoder().decode(joinedTsrgBuffer)).srg;
  } else {
    // 1.7.10–1.12.2: joined.srg inside the mcp srg zip.
    const joinedSrgZipPath = getMcpJoinedSrgPath(version);
    const joinedUrl = `${FORGE_MAVEN_BASE}/de/oceanlabs/mcp/mcp/${mcVersion}/mcp-${mcVersion}-srg.zip`;
    if (!existsSync(joinedSrgZipPath)) {
      ensureDir(dirname(joinedSrgZipPath));
      try {
        await downloadFile(joinedUrl, joinedSrgZipPath);
      } catch (error) {
        throw new MappingNotFoundError(
          version,
          'mcp',
          `Failed to download MCP SRG mappings from ${joinedUrl}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      logger.info(`Using cached joined.srg zip: ${joinedSrgZipPath}`);
    }
    const joinedSrgBuffer = readZipEntry(joinedSrgZipPath, 'joined.srg');
    if (!joinedSrgBuffer) {
      throw new MappingNotFoundError(version, 'mcp', `joined.srg not found in ${joinedSrgZipPath}`);
    }
    joinedSrg = new TextDecoder().decode(joinedSrgBuffer);
  }

  // 2. fields.csv / methods.csv from mcp_stable
  const mcpStableUrl = `${MCP_MAVEN_BASE}/de/oceanlabs/mcp/mcp_stable/${buildKey}/mcp_stable-${buildKey}.zip`;
  const stableZipPath = join(paths.mappings(), `mcp_stable-${buildKey}.zip`);
  if (!existsSync(stableZipPath)) {
    ensureDir(dirname(stableZipPath));
    try {
      await downloadFile(mcpStableUrl, stableZipPath);
    } catch (error) {
      throw new MappingNotFoundError(
        version,
        'mcp',
        `Failed to download MCP stable mappings from ${mcpStableUrl}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    logger.info(`Using cached MCP stable zip: ${stableZipPath}`);
  }

  // 3. Rebuild joined.srg → notch-mcp.srg (obfuscated → MCP)
  const fieldsCsv = readZipEntry(stableZipPath, 'fields.csv');
  const methodsCsv = readZipEntry(stableZipPath, 'methods.csv');
  if (!fieldsCsv || !methodsCsv) {
    throw new MappingNotFoundError(
      version,
      'mcp',
      `fields.csv/methods.csv not found in ${stableZipPath}`,
    );
  }

  const fields = new TextDecoder().decode(fieldsCsv);
  const methods = new TextDecoder().decode(methodsCsv);

  logger.info(`Building MCP mappings for ${version} (joined.srg -> MCP names)`);
  const result = buildJoinedMapping(joinedSrg, fields, methods);
  logger.info(
    `MCP mapping built: ${result.classes} classes, ${result.fields} fields, ${result.methods} methods`,
  );

  ensureDir(dirname(outputPath));
  writeFileSync(outputPath, result.srg, 'utf8');
  logger.info(`MCP mappings written: ${outputPath}`);

  return outputPath;
}

/**
 * Resolve the Minecraft version for the mapping artifact. Versions from
 * 1.7.10 to 1.13.2 use the tables above (mcp srg zips, then mcp_config for
 * 1.13.x); the tables cover exactly the releases MCP published.
 * (Fabric-style prerelease ids like `1.12.2-pre1` aren't covered by MCP.)
 */
function resolveMcVersion(version: string): string {
  return version;
}

function readZipEntry(zipPath: string, entryName: string): Uint8Array | null {
  const buffer = readFileSync(zipPath);
  return zipGetEntry(buffer, entryName);
}
