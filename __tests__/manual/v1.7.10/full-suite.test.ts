import { existsSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { beforeAll, describe, expect, it } from 'vitest';
import { getCacheManager } from '../../../src/cache/cache-manager.js';
import { MojangDownloader } from '../../../src/downloaders/mojang-downloader.js';
import { verifyJavaVersion } from '../../../src/java/java-process.js';
import { getDecompileService } from '../../../src/services/decompile-service.js';
import { getMappingService } from '../../../src/services/mapping-service.js';
import { getRegistryService } from '../../../src/services/registry-service.js';
import { getRemapService } from '../../../src/services/remap-service.js';
import { TEST_MAPPING, TEST_VERSION } from './test-constants.js';

/**
 * Integration Test Suite for Minecraft 1.7.10 (MCP mappings)
 *
 * 1.7.10 is the oldest version with MCP mappings published on the Forge
 * maven; the pipeline is identical to 1.12.2's:
 *   - `de.oceanlabs.mcp:mcp:1.7.10:srg` (joined.srg: obf -> SRG)
 *   - `de.oceanlabs.mcp:mcp_stable:12-1.7.10` (fields/methods.csv: SRG -> MCP)
 * Reconstructed into an obf -> MCP SRG consumed by tiny-remapper with
 * `ignoreFieldDesc` (SRG field lines carry no descriptors).
 *
 * 1.7.10 specifics this suite guards:
 * - The obfuscated JAR's classes are package-less (`a.class`); the remapped
 *   JAR must land at fully qualified MCP names (net/minecraft/...).
 * - MCP stable_12 covers ~70% of joined.srg fields via CSV ids; the rest are
 *   synthetic ($VALUES) or already human-named (enum constants) and must pass
 *   through unchanged.
 *
 * Registry extraction is NOT supported for 1.7.10 (no data generator until
 * 1.13); `get_registry_data` must produce a clear error.
 *
 * Run manually with: npm run test:manual:1.7.10
 */

describe(`Manual: Minecraft ${TEST_VERSION} (MCP mappings)`, () => {
  beforeAll(async () => {
    await verifyJavaVersion(17);
  }, 30000);

  describe('Core Pipeline', () => {
    it('should download client JAR', async () => {
      const downloader = new MojangDownloader();
      const jarPath = await downloader.downloadClientJar(TEST_VERSION);

      expect(jarPath).toBeDefined();
      expect(existsSync(jarPath)).toBe(true);
    }, 120000);

    it('should download/build MCP mappings', async () => {
      const mappingService = getMappingService();
      const mappingPath = await mappingService.getMappings(TEST_VERSION, TEST_MAPPING);

      expect(mappingPath).toBeDefined();
      expect(existsSync(mappingPath)).toBe(true);
      expect(mappingPath).toContain('mcp');
      expect(mappingPath.endsWith('.srg')).toBe(true);
    }, 120000);

    it('should remap JAR with MCP mappings', async () => {
      const remapService = getRemapService();
      const remappedPath = await remapService.getRemappedJar(TEST_VERSION, TEST_MAPPING);

      expect(remappedPath).toBeDefined();
      expect(existsSync(remappedPath)).toBe(true);
      expect(remappedPath).toContain('mcp');
    }, 300000);

    it('should contain human-readable MCP class names in remapped JAR', async () => {
      const cacheManager = getCacheManager();
      const remappedJarPath = cacheManager.getRemappedJarPath(TEST_VERSION, TEST_MAPPING);

      expect(existsSync(remappedJarPath)).toBe(true);

      const zip = new AdmZip(remappedJarPath);
      const entries = zip.getEntries();

      // 1.7.10 MCP names: net/minecraft/entity/Entity.class, etc.
      const entityClass = entries.find((e) => e.entryName === 'net/minecraft/entity/Entity.class');
      expect(entityClass).toBeDefined();

      const itemClass = entries.find((e) => e.entryName === 'net/minecraft/item/Item.class');
      expect(itemClass).toBeDefined();

      const serverClass = entries.find(
        (e) => e.entryName === 'net/minecraft/server/MinecraftServer.class',
      );
      expect(serverClass).toBeDefined();
    }, 30000);

    it('should decompile the MCP-remapped JAR', async () => {
      const decompileService = getDecompileService();
      const outputDir = await decompileService.decompileVersion(TEST_VERSION, TEST_MAPPING);

      expect(outputDir).toBeDefined();
      expect(existsSync(outputDir)).toBe(true);
      expect(existsSync(`${outputDir}/net/minecraft/entity/Entity.java`)).toBe(true);
    }, 900000);

    it('should retrieve class source with MCP names', async () => {
      const decompileService = getDecompileService();
      const source = await decompileService.getClassSource(
        TEST_VERSION,
        'net.minecraft.entity.Entity',
        TEST_MAPPING,
      );

      expect(source).toContain('package net.minecraft.entity;');
      expect(source).toContain('public abstract class Entity');
    }, 120000);
  });

  describe('Registry (unsupported for 1.7.10)', () => {
    it('should produce a clear error instead of failing obscurely', async () => {
      const registryService = getRegistryService();
      await expect(registryService.getRegistryData(TEST_VERSION)).rejects.toThrow(
        /not supported for Minecraft 1\.7\.10|data generator/,
      );
    }, 30000);
  });
});
