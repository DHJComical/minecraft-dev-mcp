import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MappingNotFoundError } from '../utils/errors.js';
import { ensureDir } from '../utils/file-utils.js';
import { logger } from '../utils/logger.js';
import {
  buildJoinedMapping,
  zipGetEntry,
} from '../utils/mcp-mappings.js';
import { getMcpJoinedSrgPath, getMcpSrgPath, paths } from '../utils/paths.js';
import { downloadFile } from './http-client.js';

/**
 * Downloader for MCP (ModCoderPack) mappings used by pre-1.14.4 Minecraft
 * versions (1.12.2 and earlier), where Mojang does not publish official
 * mappings and Fabric does not provide yarn/intermediary.
 *
 * Sources (both on maven.minecraftforge.net):
 * - `de.oceanlabs.mcp:mcp:<version>:srg`   → ZIP with `joined.srg`
 *   (obfuscated → SRG, methods carry full descriptors)
 * - `de.oceanlabs.mcp:mcp_stable:<build>-<version>` → ZIP with
 *   `fields.csv`/`methods.csv`/`params.csv` (SRG → MCP names)
 *
 * The generated artifact is an obfuscated → MCP SRG file (`mcp-<version>.srg`)
 * which tiny-remapper can consume directly (with `ignoreFieldDesc`).
 */

const FORGE_MAVEN_BASE = 'https://maven.minecraftforge.net';
const MCP_MAVEN_BASE = 'https://files.minecraftforge.net/maven';

/** MCP stable build for 1.12.2 (stable 39). Keep in sync with the MD-version table. */
const MCP_STABLE_BUILD: Record<string, string> = {
  '1.12.2': '39-1.12',
  '1.12.1': '39-1.12',
  '1.12': '39-1.12',
  '1.11.2': '39-1.11',
  '1.11.1': '39-1.11',
  '1.11': '39-1.11',
  '1.10.2': '37-1.10',
  '1.10': '37-1.10',
  '1.9.4': '36-1.9',
  '1.9.2': '32-1.9',
  '1.9': '32-1.9',
  '1.8.9': '31-1.8',
  '1.8.8': '30-1.8',
  '1.8': '28-1.8',
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
  const buildKey = MCP_STABLE_BUILD[mcVersion];
  if (!buildKey) {
    throw new MappingNotFoundError(
      version,
      'mcp',
      `No MCP stable mappings known for Minecraft ${mcVersion}; ` +
        `supported: ${Object.keys(MCP_STABLE_BUILD).join(', ')}`,
    );
  }

  // 1. joined.srg (obfuscated → SRG) from mcp:<version>:srg
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
  const joinedSrgBuffer = readZipEntry(joinedSrgZipPath, 'joined.srg');
  if (!joinedSrgBuffer) {
    throw new MappingNotFoundError(
      version,
      'mcp',
      `joined.srg not found in ${joinedSrgZipPath}`,
    );
  }
  const fieldsCsv = readZipEntry(stableZipPath, 'fields.csv');
  const methodsCsv = readZipEntry(stableZipPath, 'methods.csv');
  if (!fieldsCsv || !methodsCsv) {
    throw new MappingNotFoundError(
      version,
      'mcp',
      `fields.csv/methods.csv not found in ${stableZipPath}`,
    );
  }

  const joinedSrg = new TextDecoder().decode(joinedSrgBuffer);
  const fields = new TextDecoder().decode(fieldsCsv);
  const methods = new TextDecoder().decode(methodsCsv);

  logger.info(
    `Building MCP mappings for ${version} (joined.srg -> MCP names)`,
  );
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
 * Resolve the Minecraft version for the mapping artifact. 1.12.2 uses
 * `de.oceanlabs.mcp:mcp:1.12.2`; snapshot-style or normalized versions should
 * already match. (Fabric versions like `1.12.2-pre1` aren't covered by MCP.)
 */
function resolveMcVersion(version: string): string {
  // Accept the exact version only; MCP stable was published for a fixed set.
  return version;
}

function readZipEntry(zipPath: string, entryName: string): Uint8Array | null {
  const buffer = readFileSync(zipPath);
  return zipGetEntry(buffer, entryName);
}
