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
 * Integration Test Suite for Minecraft 1.12.2 (MCP mappings)
 *
 * 1.12.2 predates Mojang's official mappings (1.14.4+) and Fabric's
 * yarn/intermediary (1.14+), so it uses Forge MCP mappings:
 *   - `de.oceanlabs.mcp:mcp:1.12.2:srg` (joined.srg: obf -> SRG)
 *   - `de.oceanlabs.mcp:mcp_stable:39-1.12` (fields/methods.csv: SRG -> MCP)
 * Reconstructed into an obf -> MCP SRG consumed by tiny-remapper with
 * `ignoreFieldDesc` (SRG field lines carry no descriptors).
 *
 * Registry extraction is NOT supported for 1.12.2 (no data generator until
 * 1.13); `get_registry_data` must produce a clear error.
 *
 * Run manually with: npm run test:manual:1.12.2
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

      // 1.12.2 MCP names: net/minecraft/entity/Entity.class, etc.
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

  describe('Registry (unsupported for 1.12.2)', () => {
    it('should produce a clear error instead of failing obscurely', async () => {
      const registryService = getRegistryService();
      await expect(registryService.getRegistryData(TEST_VERSION)).rejects.toThrow(
        /not supported for Minecraft 1\.12\.2|data generator/,
      );
    }, 30000);
  });
});
