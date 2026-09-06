import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataGenerator } from '../java/mc-data-gen.js';
import { RegistryExtractionError } from '../utils/errors.js';
import { ensureDir } from '../utils/file-utils.js';
import { logger } from '../utils/logger.js';
import { getRegistryPath } from '../utils/paths.js';
import { getVersionManager } from './version-manager.js';

/**
 * Registry data generator (`net.minecraft.data.Main`) was added in Minecraft
 * 1.13. Versions 1.12.2 and earlier have no data generator, so registry
 * extraction is not supported for them — the server JAR is fully obfuscated
 * and cannot enumerate registries without the generator.
 */
function isPreDataGenVersion(version: string): boolean {
  const m = version.match(/^(\d+)\.(\d+)\.?/);
  if (!m) {
    // Non-1.x ids (alpha 'a1.x', beta 'b1.x', pre-classic 'rd-*') all predate
    // the data generator by many years.
    return true;
  }
  const major = Number.parseInt(m[1], 10);
  const minor = Number.parseInt(m[2], 10);
  if (major !== 1) return false;
  return minor < 13;
}

/**
 * Service for extracting and caching Minecraft registry data
 */
export class RegistryService {
  private dataGen = getDataGenerator();
  private versionManager = getVersionManager();

  /**
   * Get registry data for a version
   */
  async getRegistryData(version: string, registryType?: string): Promise<Record<string, unknown>> {
    this.throwIfUnsupported(version);
    // Get the actual registries.json file path (may be in different locations)
    const registriesFile = await this.getRegistriesFilePath(version);

    // Read registry data
    const allRegistries = this.dataGen.parseRegistryData(registriesFile);

    // Return specific registry or all
    if (registryType) {
      const registry = this.dataGen.extractRegistry(registriesFile, registryType);
      if (!registry) {
        throw new Error(`Registry '${registryType}' not found for version ${version}`);
      }
      return registry;
    }

    return allRegistries;
  }

  /**
   * Throw a clear error for versions without the Minecraft data generator
   * (1.12.2 and earlier) instead of failing obscurely inside the Java process.
   */
  private throwIfUnsupported(version: string): void {
    if (isPreDataGenVersion(version)) {
      throw new RegistryExtractionError(
        version,
        `Registry extraction is not supported for Minecraft ${version}: the data generator ` +
          `(net.minecraft.data.Main / --reports) was introduced in 1.13, and ${version} ships ` +
          `a fully obfuscated JAR without one. Only 1.13+ versions are supported.`,
      );
    }
  }

  /**
   * Get the path to registries.json, generating if needed
   */
  private async getRegistriesFilePath(version: string): Promise<string> {
    const registryDir = getRegistryPath(version);

    // Check both possible locations
    const possiblePaths = [
      join(registryDir, 'reports', 'registries.json'),
      join(registryDir, 'generated', 'reports', 'registries.json'),
      join(registryDir, 'registries.json'),
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        return path;
      }
    }

    // Not found, generate it
    logger.info(`Generating registry data for ${version}`);
    return await this.generateRegistryData(version);
  }

  /**
   * Generate registry data for a version
   */
  private async generateRegistryData(version: string): Promise<string> {
    // Get server JAR for registry extraction
    // Server JAR has the built-in data generator
    const serverJarPath = await this.versionManager.getServerJar(version);

    // Generate data
    const registryDir = getRegistryPath(version);
    ensureDir(registryDir);

    const registriesFile = await this.dataGen.generateRegistryData(
      serverJarPath,
      registryDir,
      version,
    );

    logger.info(`Registry data generated: ${registriesFile}`);
    return registriesFile;
  }

  /**
   * List available registries for a version
   */
  async listRegistries(version: string): Promise<string[]> {
    const allRegistries = await this.getRegistryData(version);
    return Object.keys(allRegistries);
  }

  /**
   * Check if registry data is cached
   */
  hasRegistryData(version: string): boolean {
    const registryDir = getRegistryPath(version);
    const registriesFile = join(registryDir, 'registries.json');
    return existsSync(registriesFile);
  }
}

// Singleton instance
let registryServiceInstance: RegistryService | undefined;

export function getRegistryService(): RegistryService {
  if (!registryServiceInstance) {
    registryServiceInstance = new RegistryService();
  }
  return registryServiceInstance;
}
