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
 * Integration Test Suite for Minecraft b1.7.3 (Feather mappings, Ornithe)
 *
 * b1.7.3 is the oldest version in this suite and represents the pre-1.7.10
 * eras: no Mojang official mappings (1.14.4+), no Fabric yarn/intermediary
 * (1.14+), and no MCP CSV artifacts (mcp_stable starts at 1.7.10). The
 * readable-names channel is Ornithe:
 *   - `net.ornithemc:calamus-intermediary:b1.7.3-client` (obf -> calamus;
 *     pre-1.3 eras ship split -client/-server artifacts, we remap the client)
 *   - `net.ornithemc:feather:b1.7.3-client+build.N` (calamus -> feather named)
 * Remap is two-step (official -> calamus -> feather), mirroring yarn.
 *
 * Registry extraction is NOT supported (no data generator until 1.13);
 * the non-1.x version id must fail fast.
 *
 * Run manually with: npm run test:manual:b1.7.3
 */

describe(`Manual: Minecraft ${TEST_VERSION} (Feather mappings, Ornithe)`, () => {
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

    it('should download/extract calamus and feather mappings', async () => {
      const mappingService = getMappingService();
      const calamusPath = await mappingService.getMappings(TEST_VERSION, 'calamus');
      expect(existsSync(calamusPath)).toBe(true);
      expect(calamusPath.endsWith('.tiny')).toBe(true);

      const featherPath = await mappingService.getMappings(TEST_VERSION, TEST_MAPPING);
      expect(existsSync(featherPath)).toBe(true);
      expect(featherPath.endsWith('.tiny')).toBe(true);
    }, 120000);

    it('should remap JAR with feather mappings (two-step)', async () => {
      const remapService = getRemapService();
      const remappedPath = await remapService.getRemappedJar(TEST_VERSION, TEST_MAPPING);

      expect(remappedPath).toBeDefined();
      expect(existsSync(remappedPath)).toBe(true);
      expect(remappedPath).toContain('feather');
    }, 300000);

    it('should contain human-readable class names in remapped JAR', async () => {
      const cacheManager = getCacheManager();
      const remappedJarPath = cacheManager.getRemappedJarPath(TEST_VERSION, TEST_MAPPING);

      expect(existsSync(remappedJarPath)).toBe(true);

      const zip = new AdmZip(remappedJarPath);
      const entries = zip.getEntries();

      const entityClass = entries.find((e) => e.entryName === 'net/minecraft/entity/Entity.class');
      expect(entityClass).toBeDefined();

      const itemClass = entries.find((e) => e.entryName === 'net/minecraft/item/Item.class');
      expect(itemClass).toBeDefined();

      const worldClass = entries.find((e) => e.entryName === 'net/minecraft/world/World.class');
      expect(worldClass).toBeDefined();

      // No calamus intermediary residue in the named JAR.
      const unmapped = entries.filter((e) => e.entryName.includes('unmapped/C_'));
      expect(unmapped.length).toBe(0);
    }, 30000);

    it('should decompile the feather-remapped JAR', async () => {
      const decompileService = getDecompileService();
      const outputDir = await decompileService.decompileVersion(TEST_VERSION, TEST_MAPPING);

      expect(outputDir).toBeDefined();
      expect(existsSync(outputDir)).toBe(true);
      expect(existsSync(`${outputDir}/net/minecraft/entity/Entity.java`)).toBe(true);
    }, 900000);

    it('should retrieve class source with feather names', async () => {
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

  describe('Registry (unsupported for b1.7.3)', () => {
    it('should fail fast for the non-1.x version id', async () => {
      const registryService = getRegistryService();
      await expect(registryService.getRegistryData(TEST_VERSION)).rejects.toThrow(
        /not supported for Minecraft b1\.7\.3|data generator/,
      );
    }, 30000);
  });
});
