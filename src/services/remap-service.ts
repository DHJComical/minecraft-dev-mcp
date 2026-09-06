import { existsSync } from 'node:fs';
import { getCacheManager } from '../cache/cache-manager.js';
import {
  downloadObfToSrgMappings,
  downloadSrgToMcpMappings,
} from '../downloaders/mcp-downloader.js';
import { getTinyRemapper } from '../java/tiny-remapper.js';
import type { MappingType, ModLoader } from '../types/minecraft.js';
import { logger } from '../utils/logger.js';
import { getMcpSrgVanillaJarPath, getRemappedJarPath } from '../utils/paths.js';
import { getMappingService } from './mapping-service.js';
import { getVersionManager } from './version-manager.js';

/**
 * Service for remapping Minecraft JARs using mappings
 */
export class RemapService {
  private tinyRemapper = getTinyRemapper();
  private cache = getCacheManager();
  private mappingService = getMappingService();
  private versionManager = getVersionManager();

  // Lock to prevent concurrent remapping of the same version+mapping
  private remapLocks = new Map<string, Promise<string>>();

  /**
   * Get or create remapped JAR
   * Uses locking to prevent concurrent remapping of the same version+mapping
   */
  async getRemappedJar(
    version: string,
    mapping: MappingType,
    onProgress?: (progress: string) => void,
  ): Promise<string> {
    const lockKey = `${version}-${mapping}`;

    // Check if remapped JAR already exists
    const outputPath = getRemappedJarPath(version, mapping);
    if (existsSync(outputPath)) {
      logger.info(`Using cached remapped JAR: ${outputPath}`);
      return outputPath;
    }

    // Check if remapping is already in progress
    const existingRemap = this.remapLocks.get(lockKey);
    if (existingRemap) {
      logger.info(`Waiting for existing remapping of ${version} (${mapping}) to complete`);
      return existingRemap;
    }

    // Start remapping with lock
    const remapPromise = this.doGetRemappedJar(version, mapping, outputPath, onProgress);
    this.remapLocks.set(lockKey, remapPromise);

    try {
      return await remapPromise;
    } finally {
      this.remapLocks.delete(lockKey);
    }
  }

  /**
   * Internal method to perform remapping
   */
  private async doGetRemappedJar(
    version: string,
    mapping: MappingType,
    outputPath: string,
    onProgress?: (progress: string) => void,
  ): Promise<string> {
    const getInputJar = async (): Promise<string> => {
      return await this.versionManager.getVersionJar(version, (downloaded, total) => {
        if (onProgress) {
          const percent = ((downloaded / total) * 100).toFixed(1);
          onProgress(`Downloading Minecraft ${version}: ${percent}%`);
        }
      });
    };

    // Minecraft 26.1+ ships unobfuscated JARs - no remapping is possible or needed.
    const isUnobfuscated = await this.versionManager.isVersionUnobfuscated(version);
    if (isUnobfuscated) {
      if (mapping !== 'mojmap') {
        throw new Error(
          `${mapping} mappings are not supported for unobfuscated Minecraft versions. ` +
            `Version ${version} ships without obfuscation - use 'mojmap' mapping instead.`,
        );
      }
      // The raw JAR is already in Mojang's human-readable names; decompile it directly.
      const inputJar = await getInputJar();
      logger.info(`Version ${version} is unobfuscated - skipping remapping (mojmap)`);
      return inputJar;
    }

    // Get input JAR (original Minecraft client)
    const inputJar = await getInputJar();

    // Yarn mappings require two-step remapping: official -> intermediary -> named
    if (mapping === 'yarn') {
      return await this.remapYarn(version, inputJar, outputPath, onProgress);
    }

    // Mojmap also requires two-step remapping: official -> intermediary -> named
    // (The converted Tiny file has intermediary -> named namespaces)
    if (mapping === 'mojmap') {
      return await this.remapMojmap(version, inputJar, outputPath, onProgress);
    }

    // MCP mappings (pre-1.14.4, e.g. 1.12.2) are a single obf -> named SRG
    // with no intermediary link, and `FD:` lines carry no descriptors — hence
    // `ignoreFieldDesc` (tiny-remapper requirement, not an option).
    if (mapping === 'mcp') {
      return await this.remapMcp(version, inputJar, outputPath, onProgress);
    }

    // Feather (Ornithe, pre-1.7.10) mirrors yarn: official -> calamus -> named
    if (mapping === 'feather') {
      return await this.remapFeather(version, inputJar, outputPath, onProgress);
    }

    // Calamus alone (obfuscated -> Ornithe intermediary classes) when the
    // caller asks for it explicitly.
    if (mapping === 'calamus') {
      const mappingsFile = await this.mappingService.getMappings(version, 'calamus');
      await this.tinyRemapper.remap(inputJar, outputPath, mappingsFile, {
        fromNamespace: 'official',
        toNamespace: 'intermediary',
        threads: 4,
        rebuildSourceFilenames: true,
        onProgress,
      });
      logger.info(`Calamus remapping complete: ${outputPath}`);
      return outputPath;
    }

    // Get mappings
    const mappingsFile = await this.mappingService.getMappings(version, mapping);

    // Determine namespaces based on mapping type
    const { fromNamespace, toNamespace } = this.getNamespaces(mapping);

    logger.info(`Remapping ${version} from ${fromNamespace} to ${toNamespace}`);

    // Perform remapping
    await this.tinyRemapper.remap(inputJar, outputPath, mappingsFile, {
      fromNamespace,
      toNamespace,
      threads: 4,
      rebuildSourceFilenames: true,
      onProgress,
    });

    logger.info(`Remapped JAR created: ${outputPath}`);
    return outputPath;
  }

  /**
   * Remap using Yarn mappings (two-step process: official -> intermediary -> named)
   */
  private async remapYarn(
    version: string,
    inputJar: string,
    outputPath: string,
    onProgress?: (progress: string) => void,
  ): Promise<string> {
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { mkdtempSync } = await import('node:fs');

    // Create temp directory for intermediary JAR
    const tempDir = mkdtempSync(join(tmpdir(), 'mc-remap-'));
    const intermediaryJar = join(tempDir, `${version}-intermediary.jar`);

    try {
      // Step 1: Remap official -> intermediary
      logger.info(`Step 1/2: Remapping ${version} from official to intermediary`);
      const intermediaryMappings = await this.mappingService.getMappings(version, 'intermediary');

      await this.tinyRemapper.remap(inputJar, intermediaryJar, intermediaryMappings, {
        fromNamespace: 'official',
        toNamespace: 'intermediary',
        threads: 4,
        rebuildSourceFilenames: false,
        onProgress: (msg) => onProgress?.(`[1/2] ${msg}`),
      });

      // Step 2: Remap intermediary -> named (Yarn)
      logger.info(`Step 2/2: Remapping ${version} from intermediary to named`);
      const yarnMappings = await this.mappingService.getMappings(version, 'yarn');

      await this.tinyRemapper.remap(intermediaryJar, outputPath, yarnMappings, {
        fromNamespace: 'intermediary',
        toNamespace: 'named',
        threads: 4,
        rebuildSourceFilenames: true,
        onProgress: (msg) => onProgress?.(`[2/2] ${msg}`),
      });

      logger.info(`Yarn remapping complete: ${outputPath}`);
      return outputPath;
    } finally {
      // Clean up temp files
      try {
        const { unlinkSync, rmdirSync } = await import('node:fs');
        if (existsSync(intermediaryJar)) {
          unlinkSync(intermediaryJar);
        }
        rmdirSync(tempDir);
      } catch (error) {
        logger.warn(`Failed to clean up temp directory: ${tempDir}`);
      }
    }
  }

  /**
   * Remap using Mojmap mappings (two-step process: official -> intermediary -> named)
   *
   * Similar to Yarn, Mojmap requires two-step remapping because:
   * 1. The converted Tiny file has namespaces: intermediary -> named
   * 2. We need to first remap from official -> intermediary
   * 3. Then remap from intermediary -> named (Mojang's official names)
   */
  private async remapMojmap(
    version: string,
    inputJar: string,
    outputPath: string,
    onProgress?: (progress: string) => void,
  ): Promise<string> {
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { mkdtempSync } = await import('node:fs');

    // Create temp directory for intermediary JAR
    const tempDir = mkdtempSync(join(tmpdir(), 'mc-remap-mojmap-'));
    const intermediaryJar = join(tempDir, `${version}-intermediary.jar`);

    try {
      // Step 1: Remap official -> intermediary
      logger.info(`Step 1/2: Remapping ${version} from official to intermediary (Mojmap)`);
      const intermediaryMappings = await this.mappingService.getMappings(version, 'intermediary');

      await this.tinyRemapper.remap(inputJar, intermediaryJar, intermediaryMappings, {
        fromNamespace: 'official',
        toNamespace: 'intermediary',
        threads: 4,
        rebuildSourceFilenames: false,
        onProgress: (msg) => onProgress?.(`[1/2] ${msg}`),
      });

      // Step 2: Remap intermediary -> named (Mojmap)
      // The converted Mojmap file has namespaces: intermediary, named
      logger.info(`Step 2/2: Remapping ${version} from intermediary to named (Mojmap)`);
      const mojmapMappings = await this.mappingService.getMappings(version, 'mojmap');

      await this.tinyRemapper.remap(intermediaryJar, outputPath, mojmapMappings, {
        fromNamespace: 'intermediary',
        toNamespace: 'named',
        threads: 4,
        rebuildSourceFilenames: true,
        ignoreConflicts: true, // Mojmap may have inheritance conflicts
        onProgress: (msg) => onProgress?.(`[2/2] ${msg}`),
      });

      logger.info(`Mojmap remapping complete: ${outputPath}`);
      return outputPath;
    } finally {
      // Clean up temp files
      try {
        const { unlinkSync, rmdirSync } = await import('node:fs');
        if (existsSync(intermediaryJar)) {
          unlinkSync(intermediaryJar);
        }
        rmdirSync(tempDir);
      } catch (error) {
        logger.warn(`Failed to clean up temp directory: ${tempDir}`);
      }
    }
  }

  /**
   * Remap using Feather mappings (two-step process: official -> calamus -> named)
   *
   * Ornithe's feather is yarn's counterpart for pre-1.7.10 versions and is
   * built on calamus the same way yarn is built on intermediary, so the
   * two-step chain is identical in shape.
   */
  private async remapFeather(
    version: string,
    inputJar: string,
    outputPath: string,
    onProgress?: (progress: string) => void,
  ): Promise<string> {
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { mkdtempSync } = await import('node:fs');

    const tempDir = mkdtempSync(join(tmpdir(), 'mc-remap-feather-'));
    const calamusJar = join(tempDir, `${version}-calamus.jar`);

    try {
      // Step 1: Remap official -> calamus intermediary
      logger.info(`Step 1/2: Remapping ${version} from official to calamus`);
      const calamusMappings = await this.mappingService.getMappings(version, 'calamus');

      await this.tinyRemapper.remap(inputJar, calamusJar, calamusMappings, {
        fromNamespace: 'official',
        toNamespace: 'intermediary',
        threads: 4,
        rebuildSourceFilenames: false,
        onProgress: (msg) => onProgress?.(`[1/2] ${msg}`),
      });

      // Step 2: Remap calamus intermediary -> named (Feather)
      logger.info(`Step 2/2: Remapping ${version} from calamus to feather`);
      const featherMappings = await this.mappingService.getMappings(version, 'feather');

      await this.tinyRemapper.remap(calamusJar, outputPath, featherMappings, {
        fromNamespace: 'intermediary',
        toNamespace: 'named',
        threads: 4,
        rebuildSourceFilenames: true,
        ignoreConflicts: true, // feather coverage has gaps in old eras
        onProgress: (msg) => onProgress?.(`[2/2] ${msg}`),
      });

      logger.info(`Feather remapping complete: ${outputPath}`);
      return outputPath;
    } finally {
      // Clean up temp files
      try {
        const { unlinkSync, rmdirSync } = await import('node:fs');
        if (existsSync(calamusJar)) {
          unlinkSync(calamusJar);
        }
        rmdirSync(tempDir);
      } catch (error) {
        logger.warn(`Failed to clean up temp directory: ${tempDir}`);
      }
    }
  }

  /**
   * Remap using MCP mappings (single-step: official/obfuscated -> MCP named).
   *
   * MCP mappings (pre-1.14.4) are obfuscated -> MCP-name SRG files. Unlike
   * Yarn/Mojmap there is no intermediary stage: the SRG `FD:` lines carry no
   * field descriptors, so we pass `ignoreFieldDesc` to tiny-remapper.
   */
  private async remapMcp(
    version: string,
    inputJar: string,
    outputPath: string,
    onProgress?: (progress: string) => void,
  ): Promise<string> {
    logger.info(`Remapping ${version} from obfuscated to MCP names`);
    const mappingsFile = await this.mappingService.getMappings(version, 'mcp');

    await this.tinyRemapper.remap(inputJar, outputPath, mappingsFile, {
      fromNamespace: 'source', // obfuscated namespace in the MCP SRG
      toNamespace: 'target', // MCP named namespace in the MCP SRG
      threads: 4,
      rebuildSourceFilenames: true,
      ignoreFieldDesc: true,
      onProgress,
    });

    logger.info(`MCP remapping complete: ${outputPath}`);
    return outputPath;
  }

  /**
   * Get namespaces for mapping type
   */
  private getNamespaces(mapping: MappingType): { fromNamespace: string; toNamespace: string } {
    switch (mapping) {
      case 'yarn':
        return { fromNamespace: 'official', toNamespace: 'named' };
      case 'mojmap':
        // Mojmap uses ProGuard format, not Tiny - handle differently
        return { fromNamespace: 'official', toNamespace: 'named' };
      case 'intermediary':
        return { fromNamespace: 'official', toNamespace: 'intermediary' };
      case 'mcp':
        return { fromNamespace: 'source', toNamespace: 'target' };
      case 'calamus':
        return { fromNamespace: 'official', toNamespace: 'intermediary' };
      case 'feather':
        return { fromNamespace: 'intermediary', toNamespace: 'named' };
      default:
        throw new Error(`Unsupported mapping type: ${mapping}`);
    }
  }

  /**
   * Check if remapped JAR exists
   */
  hasRemappedJar(version: string, mapping: MappingType): boolean {
    return this.cache.hasRemappedJar(version, mapping);
  }

  /**
   * Remap a mod JAR to human-readable names.
   *
   * Loader-aware:
   * - `fabric`/`quilt` mods (1.14+, or Ornithe/LegacyFabric pre-1.7.10) use
   *   intermediary names → remap intermediary → named.
   * - `forge`/`neoforge` mods for 1.7.10–1.13.2 ship with SRG member names
   *   and unchanged class names → member-only remap via the SRG→MCP mapping.
   */
  async remapModJar(
    inputJar: string,
    outputJar: string,
    mcVersion: string,
    toMapping: MappingType,
    onProgress?: (progress: string) => void,
    loader: ModLoader = 'fabric',
  ): Promise<string> {
    logger.info(`Remapping mod JAR: ${inputJar} -> ${outputJar} (loader: ${loader})`);

    if (loader === 'forge' || loader === 'neoforge') {
      return await this.remapForgeModJar(inputJar, outputJar, mcVersion, onProgress);
    }

    // Get mappings for the target mapping type
    const mappingsFile = await this.mappingService.getMappings(mcVersion, toMapping);

    // Fabric mods use intermediary names, so we remap from intermediary to named
    const fromNamespace = 'intermediary';
    const toNamespace = toMapping === 'intermediary' ? 'official' : 'named';

    await this.tinyRemapper.remap(inputJar, outputJar, mappingsFile, {
      fromNamespace,
      toNamespace,
      threads: 4,
      rebuildSourceFilenames: true,
      onProgress,
    });

    logger.info(`Mod JAR remapped: ${outputJar}`);
    return outputJar;
  }

  /**
   * Remap a Forge mod JAR (SRG member names) to MCP names.
   *
   * Forge mods for 1.7.10–1.13.2 keep readable class names and use
   * `func_`/`field_NNNNN` members, so a member-only SRG→MCP mapping (class
   * names identical on both sides) is what tiny-remapper consumes. The SRG
   * -named vanilla JAR is passed as classpath so the remapper can resolve
   * inheritance for MC classes the mod references but does not contain;
   * members the CSVs do not cover keep their SRG name.
   */
  private async remapForgeModJar(
    inputJar: string,
    outputJar: string,
    mcVersion: string,
    onProgress?: (progress: string) => void,
  ): Promise<string> {
    const mappingsFile = await downloadSrgToMcpMappings(mcVersion);
    const classpathJar = await this.ensureSrgVanillaJar(mcVersion);

    await this.tinyRemapper.remap(inputJar, outputJar, mappingsFile, {
      fromNamespace: 'source',
      toNamespace: 'target',
      threads: 4,
      rebuildSourceFilenames: true,
      ignoreFieldDesc: true,
      classpath: [classpathJar],
      onProgress,
    });

    logger.info(`Forge mod JAR remapped: ${outputJar}`);
    return outputJar;
  }

  /**
   * Build (or reuse) the SRG-named vanilla client JAR: the obfuscated client
   * remapped through the ordered obf→SRG mapping. This mirrors how Forge's
   * SRG-named mod environment sees MC classes.
   */
  private async ensureSrgVanillaJar(mcVersion: string): Promise<string> {
    const srgJarPath = getMcpSrgVanillaJarPath(mcVersion);
    if (existsSync(srgJarPath)) {
      logger.info(`Using cached SRG vanilla JAR: ${srgJarPath}`);
      return srgJarPath;
    }

    const obfToSrgFile = await downloadObfToSrgMappings(mcVersion);
    const clientJar = await this.versionManager.getVersionJar(mcVersion);

    logger.info(`Building SRG-named vanilla JAR for ${mcVersion}`);
    await this.tinyRemapper.remap(clientJar, srgJarPath, obfToSrgFile, {
      fromNamespace: 'source',
      toNamespace: 'target',
      threads: 4,
      rebuildSourceFilenames: false,
      ignoreFieldDesc: true,
    });
    logger.info(`SRG vanilla JAR created: ${srgJarPath}`);
    return srgJarPath;
  }
}

// Singleton instance
let remapServiceInstance: RemapService | undefined;

export function getRemapService(): RemapService {
  if (!remapServiceInstance) {
    remapServiceInstance = new RemapService();
  }
  return remapServiceInstance;
}
