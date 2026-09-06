import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MappingNotFoundError } from '../utils/errors.js';
import { ensureDir } from '../utils/file-utils.js';
import { logger } from '../utils/logger.js';
import { zipGetEntry } from '../utils/mcp-mappings.js';
import {
  getCalamusTinyPath,
  getFeatherMetadataCachePath,
  getFeatherTinyPath,
} from '../utils/paths.js';
import { downloadFile } from './http-client.js';

/**
 * Downloader for Ornithe mappings, the readable-names channel for Minecraft
 * versions before 1.7.10 (alpha 1.0.10+ through 1.6.4) where neither Mojang
 * official mappings, Fabric yarn, nor MCP CSV artifacts exist. This is the
 * same route Unimined takes for those eras.
 *
 * Artifacts (maven.ornithemc.net, both tiny v2 with `mappings/mappings.tiny`):
 * - `net.ornithemc:calamus-intermediary:<id>[-client]` → obfuscated → calamus
 *   intermediary (`net.minecraft.unmapped.C_NNNNNN` classes, `f_/m_NNNNNNN`
 *   members). Releases 1.3+ are joined; older eras ship split `-client` and
 *   `-server` artifacts — we always remap the client JAR, so the `-client`
 *   artifact is probed first.
 * - `net.ornithemc:feather:<id>[-client]+build.<n>` → calamus intermediary →
 *   feather named (human-readable; yarn's counterpart).
 *
 * The remap chain mirrors yarn's two-step: official → calamus → feather.
 */

const ORNITHE_MAVEN = 'https://maven.ornithemc.net/releases';
const CALAMUS_PATH = 'net/ornithemc/calamus-intermediary';
const FEATHER_PATH = 'net/ornithemc/feather';
const FEATHER_METADATA_URL = `${ORNITHE_MAVEN}/${FEATHER_PATH}/maven-metadata.xml`;
/** Re-fetch the feather build list after this long. */
const FEATHER_METADATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function probeUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch (error) {
    logger.debug(
      `Probe failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function calamusJarUrl(id: string): string {
  return `${ORNITHE_MAVEN}/${CALAMUS_PATH}/${id}/calamus-intermediary-${id}-v2.jar`;
}

function featherJarUrl(id: string, build: number): string {
  return `${ORNITHE_MAVEN}/${FEATHER_PATH}/${id}+build.${build}/feather-${id}+build.${build}-v2.jar`;
}

/**
 * Resolve the calamus artifact id for a Mojang version id: split eras
 * (pre-1.3) publish `<version>-client`/`<version>-server` artifacts, joined
 * eras publish `<version>`. Throws a clear error when Ornithe does not cover
 * the version at all (pre-alpha rd-* / classic, or future versions).
 */
export async function resolveCalamusArtifactId(version: string): Promise<string> {
  const splitId = `${version}-client`;
  if (await probeUrl(calamusJarUrl(splitId))) {
    return splitId;
  }
  if (await probeUrl(calamusJarUrl(version))) {
    return version;
  }
  throw new MappingNotFoundError(
    version,
    'feather',
    `No calamus-intermediary mappings on maven.ornithemc.net for Minecraft ${version} ` +
      `(probed '${splitId}' and '${version}'). Ornithe covers alpha 1.0.10+ through 1.6.4; ` +
      'pre-alpha (rd-*/classic) versions are not published, and 1.7.10+ should use mcp/yarn/mojmap.',
  );
}

/**
 * Download and extract the calamus-intermediary tiny file for a version.
 * Returns the path to the cached `calamus-<version>.tiny`.
 */
export async function downloadCalamusMappings(version: string): Promise<string> {
  const outputPath = getCalamusTinyPath(version);
  if (existsSync(outputPath)) {
    logger.info(`Using cached calamus mappings: ${outputPath}`);
    return outputPath;
  }

  const artifactId = await resolveCalamusArtifactId(version);
  const jarPath = outputPath.replace(/\.tiny$/, '.jar');
  ensureDir(dirname(jarPath));
  if (!existsSync(jarPath)) {
    const url = calamusJarUrl(artifactId);
    try {
      await downloadFile(url, jarPath);
    } catch (error) {
      throw new MappingNotFoundError(
        version,
        'calamus',
        `Failed to download calamus-intermediary from ${url}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  extractTinyFromJar(jarPath, outputPath, version, 'calamus-intermediary');
  logger.info(`Calamus mappings written: ${outputPath}`);
  return outputPath;
}

/**
 * Download and extract the feather tiny file for a version, resolving the
 * latest feather build from the cached maven metadata.
 * Returns the path to the cached `feather-<version>.tiny`.
 */
export async function downloadFeatherMappings(version: string): Promise<string> {
  const outputPath = getFeatherTinyPath(version);
  if (existsSync(outputPath)) {
    logger.info(`Using cached feather mappings: ${outputPath}`);
    return outputPath;
  }

  const artifactId = await resolveCalamusArtifactId(version);
  const build = await resolveLatestFeatherBuild(artifactId, version);
  const jarPath = outputPath.replace(/\.tiny$/, '.jar');
  ensureDir(dirname(jarPath));
  if (!existsSync(jarPath)) {
    const url = featherJarUrl(artifactId, build);
    try {
      await downloadFile(url, jarPath);
    } catch (error) {
      throw new MappingNotFoundError(
        version,
        'feather',
        `Failed to download feather from ${url}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  extractTinyFromJar(jarPath, outputPath, version, 'feather');
  logger.info(`Feather mappings written: ${outputPath}`);
  return outputPath;
}

function extractTinyFromJar(
  jarPath: string,
  outputPath: string,
  version: string,
  channel: string,
): void {
  const tiny = zipGetEntry(new Uint8Array(readFileSync(jarPath)), 'mappings/mappings.tiny');
  if (!tiny) {
    throw new MappingNotFoundError(
      version,
      channel,
      `mappings/mappings.tiny not found in ${jarPath}`,
    );
  }
  ensureDir(dirname(outputPath));
  writeFileSync(outputPath, Buffer.from(tiny));
}

/**
 * Resolve the latest feather build number for an artifact id by scanning the
 * cached feather maven-metadata.xml (refreshed when older than 24h).
 */
async function resolveLatestFeatherBuild(artifactId: string, version: string): Promise<number> {
  const xml = await getFeatherMetadata();
  const pattern = new RegExp(
    `<version>${escapeRegExp(artifactId)}\\+build\\.(\\d+)</version>`,
    'g',
  );
  let latest = 0;
  for (const match of xml.matchAll(pattern)) {
    const build = Number.parseInt(match[1], 10);
    if (build > latest) latest = build;
  }
  if (latest === 0) {
    throw new MappingNotFoundError(
      version,
      'feather',
      `No feather build published for Minecraft ${version} (artifact '${artifactId}'). ` +
        'Calamus covers it, but human-readable feather names do not exist for this version yet.',
    );
  }
  return latest;
}

async function getFeatherMetadata(): Promise<string> {
  const cachePath = getFeatherMetadataCachePath();
  ensureDir(dirname(cachePath));

  let stale = true;
  if (existsSync(cachePath)) {
    const age = Date.now() - statSync(cachePath).mtimeMs;
    stale = age > FEATHER_METADATA_MAX_AGE_MS;
  }
  if (stale) {
    logger.info('Downloading Ornithe feather build metadata');
    await downloadFile(FEATHER_METADATA_URL, cachePath);
  }
  return readFileSync(cachePath, 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
