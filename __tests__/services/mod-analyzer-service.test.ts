import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_MOD_ID,
  UNKNOWN_MOD_VERSION,
  getModAnalyzerService,
  isDetectedModId,
  isDetectedModVersion,
  isUnresolvedPlaceholder,
} from '../../src/services/mod-analyzer-service.js';
import { METEOR_JAR_PATH } from '../test-constants.js';

/**
 * Mod Analyzer Service Tests
 *
 * Tests the mod analyzer service's ability to:
 * - Analyze Fabric mod JARs
 * - Extract metadata from fabric.mod.json
 * - Detect mixins, entry points, and dependencies
 * - Parse class structure and bytecode
 * - Analyze LEGACY Forge mods (mcmod.info, 1.6.4-1.12.2), whose metadata the
 *   analyzer previously could not read at all
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Committed fixture: stub-compiled 1.12.2-style Forge mod (see fixtures/legacy-forge-src). */
const LEGACY_FORGE_JAR = join(__dirname, '..', 'fixtures', 'legacy-forge-1.12.2.jar');

describe('ModAnalyzerService', () => {
  it('should detect Meteor Client JAR exists', () => {
    expect(existsSync(METEOR_JAR_PATH)).toBe(true);
  });

  it('should analyze Meteor Client and detect Fabric loader', async () => {
    const analyzer = getModAnalyzerService();
    const result = await analyzer.analyzeMod(METEOR_JAR_PATH);

    expect(result).toBeDefined();
    expect(result.loader).toBe('fabric');
  }, 60000);

  it('should extract correct mod metadata', async () => {
    const analyzer = getModAnalyzerService();
    const result = await analyzer.analyzeMod(METEOR_JAR_PATH);

    // Meteor Client mod ID
    expect(result.metadata.id).toBe('meteor-client');

    // Version should match the version in fabric.mod.json
    expect(result.metadata.version).toBe('1.21.11-4');

    // Should have a display name
    expect(result.metadata.name).toBe('Meteor Client');

    // Should have authors
    expect(result.metadata.authors.length).toBeGreaterThan(0);

    // Should have description
    expect(result.metadata.description).toBeDefined();
    expect(result.metadata.description?.length).toBeGreaterThan(0);
  }, 60000);

  it('should detect Minecraft version compatibility', async () => {
    const analyzer = getModAnalyzerService();
    const result = await analyzer.analyzeMod(METEOR_JAR_PATH);

    // Should require Minecraft 1.21.x
    expect(result.compatibility.minecraft).toContain('1.21');

    // Should be client-side mod
    expect(result.compatibility.environment).toBe('client');
  }, 60000);

  it('should extract dependencies', async () => {
    const analyzer = getModAnalyzerService();
    const result = await analyzer.analyzeMod(METEOR_JAR_PATH);

    // Should have dependencies
    expect(result.dependencies.length).toBeGreaterThan(0);

    // Should depend on Minecraft
    const mcDep = result.dependencies.find((d) => d.modId === 'minecraft');
    expect(mcDep).toBeDefined();

    // Should depend on Fabric Loader
    const loaderDep = result.dependencies.find((d) => d.modId === 'fabricloader');
    expect(loaderDep).toBeDefined();

    // Should have Java requirement
    const javaDep = result.dependencies.find((d) => d.modId === 'java');
    expect(javaDep).toBeDefined();
  }, 60000);

  it('should extract entry points', async () => {
    const analyzer = getModAnalyzerService();
    const result = await analyzer.analyzeMod(METEOR_JAR_PATH);

    // Should have entry points
    expect(result.entrypoints.length).toBeGreaterThan(0);

    // Should have a client entrypoint (Meteor is a client mod)
    const clientEntry = result.entrypoints.find((e) => e.type === 'client');
    expect(clientEntry).toBeDefined();
  }, 60000);

  it('should detect mixin configurations', async () => {
    const analyzer = getModAnalyzerService();
    const result = await analyzer.analyzeMod(METEOR_JAR_PATH);

    // Meteor Client uses mixins extensively
    expect(result.mixins.length).toBeGreaterThan(0);

    // Should have mixin classes listed
    const firstConfig = result.mixins[0];
    expect(firstConfig.configFile).toBeDefined();

    // Should have a package defined
    expect(firstConfig.package).toBeDefined();
  }, 60000);

  it('should analyze class structure', async () => {
    const analyzer = getModAnalyzerService();
    const result = await analyzer.analyzeMod(METEOR_JAR_PATH);

    // Should have many classes (Meteor is a large mod)
    expect(result.classes.total).toBeGreaterThan(500);

    // Should have package breakdown
    expect(Object.keys(result.classes.packages).length).toBeGreaterThan(10);

    // Should detect mixin classes
    expect(result.classes.mixinClasses.length).toBeGreaterThan(0);

    // Should have detected entrypoint classes
    expect(result.classes.entrypointClasses.length).toBeGreaterThan(0);
  }, 60000);

  it('should detect mixin classes via bytecode analysis', async () => {
    const analyzer = getModAnalyzerService();
    const result = await analyzer.analyzeMod(METEOR_JAR_PATH, {
      analyzeBytecode: true,
    });

    // Should have mixin classes detected
    expect(result.classes.mixinClasses.length).toBeGreaterThan(0);

    // At least one mixin should have isMixin = true
    const mixinWithFlag = result.classes.mixinClasses.find((c) => c.isMixin);
    expect(mixinWithFlag).toBeDefined();
  }, 60000);

  it('should include all classes when requested', async () => {
    const analyzer = getModAnalyzerService();
    const result = await analyzer.analyzeMod(METEOR_JAR_PATH, {
      includeAllClasses: true,
    });

    // Should have allClasses populated
    expect(result.classes.allClasses).toBeDefined();
    expect(result.classes.allClasses?.length).toBe(result.classes.total);
  }, 120000);

  it('should include raw metadata when requested', async () => {
    const analyzer = getModAnalyzerService();
    const result = await analyzer.analyzeMod(METEOR_JAR_PATH, {
      includeRawMetadata: true,
    });

    // Should have raw fabric.mod.json
    expect(result.rawMetadata).toBeDefined();
    expect(result.rawMetadata?.fabricModJson).toBeDefined();

    // Should have raw mixin configs
    expect(result.rawMetadata?.mixinConfigs).toBeDefined();
    expect(Object.keys(result.rawMetadata?.mixinConfigs ?? {}).length).toBeGreaterThan(0);
  }, 60000);

  it('should report analysis metadata', async () => {
    const analyzer = getModAnalyzerService();
    const result = await analyzer.analyzeMod(METEOR_JAR_PATH);

    // Should have analysis metadata
    expect(result.analysis.jarPath).toBe(METEOR_JAR_PATH);
    expect(result.analysis.jarSize).toBeGreaterThan(0);
    expect(result.analysis.analyzedAt).toBeDefined();
    expect(result.analysis.durationMs).toBeGreaterThan(0);
  }, 60000);

  it('should handle nested JARs (Jar-in-Jar)', async () => {
    const analyzer = getModAnalyzerService();
    const result = await analyzer.analyzeMod(METEOR_JAR_PATH);

    // Meteor may bundle some dependencies as nested JARs
    // This test just verifies the field exists (may be empty if no nested JARs)
    expect(result.nestedJars === undefined || Array.isArray(result.nestedJars)).toBe(true);
  }, 60000);

  it('should handle JAR path with spaces (if applicable)', async () => {
    // This test uses the existing JAR - just verifies the path handling works
    const analyzer = getModAnalyzerService();
    const result = await analyzer.analyzeMod(METEOR_JAR_PATH);

    expect(result).toBeDefined();
    expect(result.loader).toBe('fabric');
  }, 60000);
});

/**
 * Legacy Forge support (1.6.4 - 1.12.2).
 *
 * These mods declare themselves in `mcmod.info` instead of `mods.toml`, and
 * named members by SRG id. Before this was implemented every one of them
 * analyzed as `unknown` / `0.0.0`, which also made `decompile_mod_jar` route
 * them all into one shared cache directory.
 */
describe('ModAnalyzerService: legacy Forge (mcmod.info)', () => {
  const analyzer = getModAnalyzerService();

  it('uses the committed fixture JAR', () => {
    expect(existsSync(LEGACY_FORGE_JAR)).toBe(true);
  });

  it('detects the loader and the mod identity from mcmod.info', async () => {
    const result = await analyzer.analyzeMod(LEGACY_FORGE_JAR);

    expect(result.loader).toBe('forge');
    expect(result.metadata.id).toBe('legacymod');
    expect(result.metadata.version).toBe('1.2.3');
    expect(result.metadata.name).toBe('Legacy Mod');
    expect(result.metadata.description).toBeTruthy();
    expect(result.metadata.icon).toBe('assets/legacymod/logo.png');
    expect(result.metadata.contact?.homepage).toBe('https://example.com/legacymod');
  });

  it('splits packed author strings', async () => {
    const result = await analyzer.analyzeMod(LEGACY_FORGE_JAR);
    expect(result.metadata.authors.map((a) => a.name)).toEqual(['Aaa Bbb', 'Ccc Ddd']);
  });

  it('reports the Minecraft version from mcversion', async () => {
    const result = await analyzer.analyzeMod(LEGACY_FORGE_JAR);

    expect(result.compatibility.minecraft).toBe('1.12.2');
    // Exposed as a dependency too, which is what remap_mod_jar auto-detects from.
    expect(result.dependencies.find((d) => d.modId === 'minecraft')?.versionRange).toBe('1.12.2');
  });

  it('reports requiredMods as required and dependencies as ordering', async () => {
    const result = await analyzer.analyzeMod(LEGACY_FORGE_JAR);

    const forge = result.dependencies.find((d) => d.modId === 'forge');
    expect(forge).toMatchObject({ type: 'required', mandatory: true });

    // Listed in BOTH requiredMods and dependencies; only the stronger entry
    // survives, so the output does not contradict itself.
    const chameleon = result.dependencies.filter((d) => d.modId === 'chameleon');
    expect(chameleon).toHaveLength(1);
    expect(chameleon[0]).toMatchObject({ type: 'required', mandatory: true });
  });

  it('recovers the @Mod entry point and the legacy coremod from bytecode', async () => {
    const result = await analyzer.analyzeMod(LEGACY_FORGE_JAR);

    expect(result.entrypoints).toContainEqual({
      type: 'mod',
      value: 'com.example.legacy.LegacyMod',
    });
    // Declared by MANIFEST.MF FMLCorePlugin + the implemented FML interface.
    expect(result.entrypoints).toContainEqual({
      type: 'coremod',
      value: 'com.example.legacy.LegacyCorePlugin',
    });
  });

  it('finds a mixin config that only MANIFEST.MF declares', async () => {
    const result = await analyzer.analyzeMod(LEGACY_FORGE_JAR);

    // The config is named `mixins.legacymod.json`, so a `*.mixins.json`
    // filename scan alone would miss it — the manifest is what finds it.
    expect(result.mixins.map((m) => m.configFile)).toEqual(['mixins.legacymod.json']);
    const config = result.mixins[0];
    expect(config?.package).toBe('com.example.legacy.mixin');
    expect(config?.mixins).toEqual(['WorldMixin', 'AliasMixin']);
    expect(config?.minVersion).toBe('0.7.11');
    expect(config?.compatibilityLevel).toBe('JAVA_8');
  });

  it('finds the access transformer declared by FMLAT, without duplicating the META-INF copy', async () => {
    const result = await analyzer.analyzeMod(LEGACY_FORGE_JAR);

    expect(result.accessTransformers).toEqual(['legacymod_at.cfg']);
  });

  it('extracts mixin targets, including CLASS-retention @Mixin annotations', async () => {
    const result = await analyzer.analyzeMod(LEGACY_FORGE_JAR);

    const worldMixin = result.classes.mixinClasses.find(
      (c) => c.className === 'com.example.legacy.mixin.WorldMixin',
    );
    expect(worldMixin?.mixinTargets).toEqual(['net.minecraft.world.World']);
  });

  it('does not mistake mixin classes for mod entry points', async () => {
    const result = await analyzer.analyzeMod(LEGACY_FORGE_JAR);

    const modEntrypoints = result.entrypoints.filter((e) => e.type === 'mod');
    expect(modEntrypoints).toHaveLength(1);
  });

  it('exposes the parsed mcmod.info and manifest as raw metadata', async () => {
    const result = await analyzer.analyzeMod(LEGACY_FORGE_JAR, { includeRawMetadata: true });

    expect(result.rawMetadata?.mcmodInfo).toBeTruthy();
    expect(result.rawMetadata?.manifest?.mixinconfigs).toBe('mixins.legacymod.json');
  });
});

describe('ModAnalyzerService: metadata gaps are reported, not invented', () => {
  const analyzer = getModAnalyzerService();

  /** Build a throwaway JAR with the given entries. */
  function makeJar(entries: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'mod-analyzer-'));
    const jarPath = join(dir, 'mod.jar');
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(entries)) {
      zip.addFile(name, Buffer.from(content, 'utf8'));
    }
    writeFileSync(jarPath, zip.toBuffer());
    return jarPath;
  }

  it('falls back to MANIFEST.MF Implementation-Version when no metadata file exists', async () => {
    const jarPath = makeJar({
      'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nImplementation-Version: 4.5.6\n',
    });
    try {
      const result = await analyzer.analyzeMod(jarPath);

      expect(result.metadata.version).toBe('4.5.6');
      expect(isDetectedModVersion(result.metadata.version)).toBe(true);
      // The id is still unknown — and said so, rather than being guessed.
      expect(result.metadata.id).toBe(UNKNOWN_MOD_ID);
      expect(isDetectedModId(result.metadata.id)).toBe(false);
      expect(result.warnings?.join(' ')).toMatch(
        /Mod version recovered from MANIFEST\.MF: '4\.5\.6'/,
      );
    } finally {
      rmSync(dirname(jarPath), { recursive: true, force: true });
    }
  });

  it('warns when a JAR has no recognizable metadata at all', async () => {
    const jarPath = makeJar({ 'readme.txt': 'nothing to see' });
    try {
      const result = await analyzer.analyzeMod(jarPath);

      expect(result.loader).toBe('unknown');
      expect(result.metadata.id).toBe(UNKNOWN_MOD_ID);
      expect(result.metadata.version).toBe(UNKNOWN_MOD_VERSION);
      expect(result.warnings?.join(' ')).toMatch(/No recognized mod metadata/);
    } finally {
      rmSync(dirname(jarPath), { recursive: true, force: true });
    }
  });

  it('treats unresolved build placeholders as undetected', async () => {
    // ForgeGradle/Loom leave `${mod_id}` in sources-JAR metadata; using it as a
    // cache directory would literally create a folder named `${mod_id}`.
    const jarPath = makeJar({
      'META-INF/mods.toml':
        'modLoader="javafml"\n[[mods]]\nmodId="${mod_id}"\nversion="${version}"\n',
    });
    try {
      const result = await analyzer.analyzeMod(jarPath);

      expect(isUnresolvedPlaceholder(result.metadata.id)).toBe(true);
      expect(isDetectedModId(result.metadata.id)).toBe(false);
      expect(isDetectedModVersion(result.metadata.version)).toBe(false);
      expect(result.warnings?.join(' ')).toMatch(/unresolved build placeholders/);
    } finally {
      rmSync(dirname(jarPath), { recursive: true, force: true });
    }
  });
});
