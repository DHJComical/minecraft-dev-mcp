import { existsSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { beforeAll, describe, expect, it } from 'vitest';
import { getCacheManager } from '../../../src/cache/cache-manager.js';
import { MojangDownloader } from '../../../src/downloaders/mojang-downloader.js';
import { verifyJavaVersion } from '../../../src/java/java-process.js';
import { getDecompileService } from '../../../src/services/decompile-service.js';
import { getMappingService } from '../../../src/services/mapping-service.js';
import { getRemapService } from '../../../src/services/remap-service.js';
import { TEST_MAPPING, TEST_VERSION } from './test-constants.js';

/**
 * Integration Test Suite for Minecraft 1.13.2 (MCP mappings)
 *
 * 1.13.x is a special era: no Mojang official mappings (1.14.4+), no Fabric
 * yarn/intermediary (1.14+), and the plain `mcp:<v>:srg` zips stop at 1.12.x.
 * Mappings come from MCPConfig instead (`de.oceanlabs.mcp:mcp_config:1.13.2`,
 * `config/joined.tsrg`, tsrg v1) joined with `mcp_stable:47-1.13.2` CSVs —
 * the same route Unimined/ForgeGradle 3 take. The reconstructed obf → MCP
 * SRG is consumed by tiny-remapper with `ignoreFieldDesc`.
 *
 * Registry extraction is intentionally not asserted here: 1.13 is the
 * boundary where the data generator appeared, so the <1.13 fast-fail does
 * not apply and registry behavior is exercised by the 1.19.4+ suites.
 *
 * Run manually with: npm run test:manual:1.13.2
 */

describe(`Manual: Minecraft ${TEST_VERSION} (MCP mappings via MCPConfig)`, () => {
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

    it('should download/build MCP mappings from mcp_config joined.tsrg', async () => {
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

      // 1.13.2 MCP names: net/minecraft/entity/Entity.class, etc.
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
      expect(source).toContain('class Entity');
    }, 120000);
  });
});
