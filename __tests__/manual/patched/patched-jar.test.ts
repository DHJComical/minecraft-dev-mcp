import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getCacheManager } from '../../../src/cache/cache-manager.js';
import { verifyJavaVersion } from '../../../src/java/java-process.js';
import { handleCompareVersions } from '../../../src/server/tools.js';
import { getAccessTransformerService } from '../../../src/services/access-transformer-service.js';
import { getDecompileService } from '../../../src/services/decompile-service.js';
import { getSearchIndexService } from '../../../src/services/search-index-service.js';
import { inspectJar } from '../../../src/utils/jar-inspector.js';
import { getDecompiledPath } from '../../../src/utils/paths.js';
import {
  LOADER_PACKAGE_PREFIX,
  PATCHED_JAR_PATH,
  PATCHED_LOADER,
  PATCHED_MAPPING,
  PATCHED_MC_VERSION,
  PATCHED_VERSION,
} from './test-constants.js';

/**
 * Patched Minecraft JAR end-to-end suite.
 *
 * Validates that a Forge/NeoForge patched MC JAR can flow through the entire
 * pipeline as a peer of vanilla decompilations:
 *   decompile (or extract sources) → get_minecraft_source → search → index → compare_versions
 *
 * Skipped automatically when PATCHED_JAR_PATH is unset, so this suite is a
 * no-op for contributors who don't have a patched JAR locally. CI provides
 * the env vars after generating a JAR via NFRT/ForgeGradle.
 */

const SKIP = !PATCHED_JAR_PATH || !existsSync(PATCHED_JAR_PATH);
const describePatched = SKIP ? describe.skip : describe;

if (SKIP) {
  console.warn(
    `[patched-jar.test] Skipping: PATCHED_JAR_PATH is unset or does not exist (${PATCHED_JAR_PATH || '<empty>'})`,
  );
}

function countJavaFiles(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.java')) n++;
    }
  };
  walk(dir);
  return n;
}

function findFirstClassUnder(decompiledDir: string, packagePrefix: string): string | null {
  const root = join(decompiledDir, packagePrefix.replace(/\./g, '/'));
  if (!existsSync(root) || !statSync(root).isDirectory()) return null;
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.java')) {
        return relative(decompiledDir, full)
          .replace(/[/\\]/g, '.')
          .replace(/\.java$/, '');
      }
    }
  }
  return null;
}

describePatched(`Manual: Patched MC JAR pipeline (${PATCHED_VERSION || 'no-version'})`, () => {
  beforeAll(async () => {
    expect(PATCHED_JAR_PATH).toBeTruthy();
    expect(PATCHED_VERSION).toBeTruthy();
    expect(PATCHED_MC_VERSION).toBeTruthy();
    expect(['forge', 'neoforge']).toContain(PATCHED_LOADER);
    await verifyJavaVersion(17);
  }, 30000);

  describe('Decompile (or extract sources)', () => {
    it('processes the patched JAR and writes decompiled output', async () => {
      const decompileService = getDecompileService();

      // Force-clear so this run is hermetic regardless of prior cache state.
      decompileService.forceClear(PATCHED_VERSION, PATCHED_MAPPING);

      const result = await decompileService.decompileLocalJar(
        PATCHED_JAR_PATH,
        PATCHED_VERSION,
        PATCHED_MAPPING,
      );

      expect(result.outputDir).toBe(getDecompiledPath(PATCHED_VERSION, PATCHED_MAPPING));
      expect(existsSync(result.outputDir)).toBe(true);
      expect(['decompiled', 'extracted']).toContain(result.mode);

      // Real patched MC JARs always contain thousands of files.
      const javaCount = countJavaFiles(result.outputDir);
      expect(javaCount).toBeGreaterThan(500);
    }, 1_200_000);

    it('emits net.minecraft.* vanilla code', () => {
      const decompiledDir = getDecompiledPath(PATCHED_VERSION, PATCHED_MAPPING);
      const minecraftClass = findFirstClassUnder(decompiledDir, 'net.minecraft');
      expect(minecraftClass).not.toBeNull();
    }, 30000);

    it(`emits ${LOADER_PACKAGE_PREFIX}.* loader code (proves patched, not vanilla)`, () => {
      const decompiledDir = getDecompiledPath(PATCHED_VERSION, PATCHED_MAPPING);
      const loaderClass = findFirstClassUnder(decompiledDir, LOADER_PACKAGE_PREFIX);
      expect(loaderClass).not.toBeNull();
    }, 30000);
  });

  describe('Access transformer validation (bytecode ground truth)', () => {
    // The AT/AW validators read the REMAPPED JAR, which the patched flow does
    // not produce by remapping — decompileLocalJar registers the input JAR as
    // this key's remapped JAR instead. Without that, a NeoForge user gets
    // "run decompile_minecraft_version first" right after decompiling.
    const isSourcesJar = () => inspectJar(PATCHED_JAR_PATH as string).type === 'sources';

    it("registers the patched JAR as the version key's remapped JAR", () => {
      if (isSourcesJar()) return; // no bytecode exists in a sources-JAR flow
      expect(getCacheManager().hasRemappedJar(PATCHED_VERSION, PATCHED_MAPPING)).toBe(true);
    }, 30000);

    it('validates an AT against the patched key without a "not available" error', async () => {
      const svc = getAccessTransformerService();
      // A class every patched MC JAR has, widened at class level only.
      const at = svc.parseAccessTransformer('public net.minecraft.world.entity.Entity\n');
      const validation = await svc.validateAccessTransformer(at, PATCHED_VERSION, PATCHED_MAPPING);

      if (isSourcesJar()) {
        // Sources JARs genuinely cannot be validated — but the message must
        // explain that, not loop the user back to decompiling.
        expect(validation.errors[0]?.message).toContain('sources JAR');
        return;
      }

      expect(validation.errors.map((e) => e.message)).toEqual([]);
      expect(validation.isValid).toBe(true);
    }, 120000);
  });

  describe('Source retrieval', () => {
    it('get_minecraft_source returns Entity from the patched JAR', async () => {
      const decompileService = getDecompileService();
      const source = await decompileService.getClassSource(
        PATCHED_VERSION,
        'net.minecraft.world.entity.Entity',
        PATCHED_MAPPING,
      );
      expect(source).toContain('class Entity');
    }, 60000);
  });

  describe('Search index', () => {
    it('indexes the patched version and finds loader-package symbols', async () => {
      const search = getSearchIndexService();
      // clearIndex is idempotent; explicit so a stale half-index from a prior
      // run can't poison the assertion.
      search.clearIndex(PATCHED_VERSION, PATCHED_MAPPING);

      const result = await search.indexVersion(PATCHED_VERSION, PATCHED_MAPPING);
      expect(result.fileCount).toBeGreaterThan(500);

      // FTS5 tokenization splits on dots, so query the package leaf.
      const leaf = LOADER_PACKAGE_PREFIX.split('.').pop() as string;
      const hits = search.search(leaf, PATCHED_VERSION, PATCHED_MAPPING, { limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
    }, 600000);
  });

  describe('compare_versions vs vanilla', () => {
    it('lists loader classes as added when comparing vanilla MC vs patched', async () => {
      // Ensure vanilla MC is also decompiled so the comparison has both sides.
      const decompileService = getDecompileService();
      const cache = getCacheManager();
      if (!cache.hasDecompiledSource(PATCHED_MC_VERSION, PATCHED_MAPPING)) {
        await decompileService.decompileVersion(PATCHED_MC_VERSION, PATCHED_MAPPING);
      }

      const result = await handleCompareVersions({
        fromVersion: PATCHED_MC_VERSION,
        toVersion: PATCHED_VERSION,
        mapping: PATCHED_MAPPING,
        category: 'classes',
      });

      const text = result.content[0]?.text ?? '';
      const parsed = JSON.parse(text);
      expect(parsed.classes).toBeDefined();
      // The loader injects an entire package tree of new classes.
      expect(parsed.classes.addedCount).toBeGreaterThan(0);
      const hasLoaderAdded = (parsed.classes.added as string[]).some((c) =>
        c.startsWith(LOADER_PACKAGE_PREFIX),
      );
      expect(hasLoaderAdded).toBe(true);
    }, 1_200_000);
  });

  describe('Force flag', () => {
    it('force-clear wipes the directory and lets re-decompile run again', async () => {
      const decompileService = getDecompileService();
      const dir = getDecompiledPath(PATCHED_VERSION, PATCHED_MAPPING);

      // Sanity: directory exists from prior test.
      expect(existsSync(dir)).toBe(true);

      decompileService.forceClear(PATCHED_VERSION, PATCHED_MAPPING);
      expect(existsSync(dir)).toBe(false);

      const result = await decompileService.decompileLocalJar(
        PATCHED_JAR_PATH,
        PATCHED_VERSION,
        PATCHED_MAPPING,
      );
      expect(existsSync(result.outputDir)).toBe(true);
    }, 1_200_000);
  });
});
