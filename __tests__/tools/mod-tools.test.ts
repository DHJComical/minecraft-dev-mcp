import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { getVineflower } from '../../src/java/vineflower.js';
import {
  classifySearchHits,
  extractConcreteVersion,
  handleAnalyzeModJar,
  handleDecompileModJar,
  handleIndexMod,
  handleRemapModJar,
  handleSearchModCode,
  handleSearchModIndexed,
} from '../../src/server/tools.js';
import { METEOR_JAR_PATH, TEST_MAPPING } from '../test-constants.js';

// Paths for remapped/decompiled mod
const METEOR_REMAPPED_PATH = join(dirname(METEOR_JAR_PATH), 'meteor-client-remapped-yarn.jar');

/**
 * Mod Analysis MCP Tool Tests
 *
 * Tests the mod analysis, remapping, decompilation, and search tools:
 * - analyze_mod_jar: Analyzes Fabric/Forge/Quilt mod JARs
 * - remap_mod_jar: Remaps mods to human-readable mappings
 * - decompile_mod_jar: Decompiles mod JARs to readable source
 * - search_mod_code / search_mod_indexed: Search decompiled mod code
 * - index_mod: Create FTS5 search index for mod source
 */

describe('MCP Tool: analyze_mod_jar', () => {
  it('should work via MCP tool handler', async () => {
    const response = await handleAnalyzeModJar({
      jarPath: METEOR_JAR_PATH,
    });

    expect(response).toBeDefined();
    expect(response.isError).toBeUndefined();
    expect(response.content).toBeDefined();
    expect(response.content.length).toBe(1);
    expect(response.content[0].type).toBe('text');

    // Parse the JSON response
    const result = JSON.parse(response.content[0].text);
    expect(result.loader).toBe('fabric');
    expect(result.metadata.id).toBe('meteor-client');
  }, 60000);

  it('should return error for non-existent JAR', async () => {
    const response = await handleAnalyzeModJar({
      jarPath: '/nonexistent/path/to/mod.jar',
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('not found');
  }, 10000);

  it('should include all classes when flag is set', async () => {
    const response = await handleAnalyzeModJar({
      jarPath: METEOR_JAR_PATH,
      includeAllClasses: true,
    });

    expect(response.isError).toBeUndefined();

    const result = JSON.parse(response.content[0].text);
    expect(result.classes.allClasses).toBeDefined();
    expect(result.classes.allClasses.length).toBeGreaterThan(0);
  }, 120000);

  it('should include raw metadata when flag is set', async () => {
    const response = await handleAnalyzeModJar({
      jarPath: METEOR_JAR_PATH,
      includeRawMetadata: true,
    });

    expect(response.isError).toBeUndefined();

    const result = JSON.parse(response.content[0].text);
    expect(result.rawMetadata).toBeDefined();
    expect(result.rawMetadata.fabricModJson).toBeDefined();
  }, 60000);
});

describe('MCP Tool: remap_mod_jar', () => {
  it('rejects `mcp` as a target for a Fabric mod with an actionable message', async () => {
    // `mcp` names only exist for Forge-era mods. Accepting the value silently
    // would remap a Fabric mod's intermediary members through a nonexistent
    // mapping; accepting it at all matters because "remap this 1.12.2 mod to
    // MCP names" is the natural way to ask for a Forge mod.
    const response = await handleRemapModJar({
      inputJar: METEOR_JAR_PATH,
      outputJar: join(dirname(METEOR_JAR_PATH), 'never-written.jar'),
      toMapping: 'mcp',
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/only applies to Forge\/NeoForge/);
    expect(response.content[0].text).toMatch(/detected loader: fabric/);
  }, 120000);

  it('should remap mod JAR to yarn mappings with explicit version', async () => {
    const response = await handleRemapModJar({
      inputJar: METEOR_JAR_PATH,
      outputJar: METEOR_REMAPPED_PATH,
      mcVersion: '1.21.11',
      toMapping: 'yarn',
    });

    expect(response.isError).toBeUndefined();
    expect(response.content).toBeDefined();

    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.outputJar).toBeDefined();
    expect(existsSync(METEOR_REMAPPED_PATH)).toBe(true);

    // Verify the remapped JAR is different from the original
    const originalSize = statSync(METEOR_JAR_PATH).size;
    const remappedSize = statSync(METEOR_REMAPPED_PATH).size;

    // Remapped JAR should be a valid file (not the same as original)
    // They may have similar sizes but should not be identical
    expect(remappedSize).toBeGreaterThan(0);

    // Validate that Minecraft references were actually remapped to Yarn names
    // We'll decompile a known mixin class that references Minecraft code
    const vineflower = getVineflower();
    const tempDir = mkdtempSync(join(tmpdir(), 'meteor-remap-test-'));

    try {
      // Decompile MinecraftClientMixin - this class definitely references MinecraftClient
      await vineflower.decompile(METEOR_REMAPPED_PATH, tempDir);

      // Read the decompiled mixin class
      const mixinPath = join(
        tempDir,
        'meteordevelopment',
        'meteorclient',
        'mixin',
        'MinecraftClientMixin.java',
      );
      expect(existsSync(mixinPath)).toBe(true);

      const decompiledCode = readFileSync(mixinPath, 'utf-8');

      // Verify it contains Yarn class names (human-readable) in imports and code
      // These confirm the remapping to Yarn worked correctly
      expect(decompiledCode).toMatch(/import.*\bMinecraftClient\b/);
      expect(decompiledCode).toMatch(/import.*\bClientWorld\b/);
      expect(decompiledCode).toMatch(/import.*\bClientPlayerEntity\b/);

      // Verify class references in the actual code use Yarn names
      expect(decompiledCode).toMatch(/public.*\bClientWorld\b.*field_/);

      // Note: We don't check for absence of class_XXX because Mixin annotation target strings
      // (like @At(target = "Lnet/minecraft/class_636;...")) use intermediary names by design.
      // These are bytecode descriptors and are expected. The important thing is that imports
      // and actual Java code use Yarn class names, which we verified above.
    } finally {
      // Clean up temp directory
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 300000); // 5 minutes - remapping can take a while

  it('should auto-detect Minecraft version when not provided', async () => {
    // Use a different output path for this test
    const autoDetectOutputPath = join(
      dirname(METEOR_JAR_PATH),
      'meteor-client-remapped-yarn-autodetect.jar',
    );

    const response = await handleRemapModJar({
      inputJar: METEOR_JAR_PATH,
      outputJar: autoDetectOutputPath,
      // mcVersion intentionally omitted - should auto-detect
      toMapping: 'yarn',
    });

    expect(response.isError).toBeUndefined();
    expect(response.content).toBeDefined();

    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.mcVersion).toBe('1.21.11'); // Should have auto-detected this version
    expect(result.outputJar).toBeDefined();
    expect(existsSync(autoDetectOutputPath)).toBe(true);

    // Clean up
    rmSync(autoDetectOutputPath, { force: true });
  }, 300000); // 5 minutes - remapping can take a while
});

describe('MCP Tool: decompile_mod_jar', () => {
  it.skipIf(!existsSync(METEOR_REMAPPED_PATH))(
    'should decompile remapped mod JAR',
    async () => {
      const response = await handleDecompileModJar({
        jarPath: METEOR_REMAPPED_PATH,
        mapping: TEST_MAPPING,
      });

      if (response.isError) {
        console.error('Decompile error:', response.content[0].text);
      }

      expect(response.isError).toBeUndefined();
      expect(response.content).toBeDefined();

      const result = JSON.parse(response.content[0].text);
      expect(result.success).toBe(true);
      expect(result.modId).toBe('meteor-client');
      expect(result.modVersion).toBeDefined();
      expect(result.outputDirectory).toBeDefined();
    },
    600000,
  ); // 10 minutes - decompilation takes a while
});

describe('MCP Tool: search_mod_code', () => {
  it('should search decompiled mod source code', async () => {
    const response = await handleSearchModCode({
      modId: 'meteor-client',
      modVersion: '0.5.9', // meteor-client-1.21.11-4.jar version
      query: 'onTick',
      searchType: 'method',
      mapping: TEST_MAPPING,
    });

    // If mod not decompiled, it should return an error
    if (response.isError) {
      expect(response.content[0].text).toMatch(/not decompiled|Decompiled source not found/i);
      return;
    }

    const result = JSON.parse(response.content[0].text);
    expect(result.query).toBe('onTick');
    expect(result.searchType).toBe('method');
    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
  }, 60000);
});

describe('MCP Tool: index_mod', () => {
  it('should index decompiled mod source', async () => {
    const response = await handleIndexMod({
      modId: 'meteor-client',
      modVersion: '0.5.9',
      mapping: TEST_MAPPING,
    });

    // If mod not decompiled, it should return an error
    if (response.isError) {
      expect(response.content[0].text).toMatch(/not decompiled|Decompiled source not found/i);
      return;
    }

    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.modId).toBe('meteor-client');
    expect(result.filesIndexed).toBeGreaterThan(0);
  }, 300000); // 5 minutes - indexing takes a while
});

describe('MCP Tool: search_mod_indexed', () => {
  it('should search mod using FTS5 index', async () => {
    const response = await handleSearchModIndexed({
      query: 'packet',
      modId: 'meteor-client',
      modVersion: '0.5.9',
      mapping: TEST_MAPPING,
    });

    // If mod not indexed, it should return an error
    if (response.isError) {
      expect(response.content[0].text).toContain('not indexed');
      return;
    }

    const result = JSON.parse(response.content[0].text);
    expect(result.query).toBe('packet');
    expect(result.results).toBeDefined();
    expect(Array.isArray(result.results)).toBe(true);
  }, 30000);

  it('should support FTS5 syntax with AND operator', async () => {
    const response = await handleSearchModIndexed({
      query: 'packet AND send',
      modId: 'meteor-client',
      modVersion: '0.5.9',
      mapping: TEST_MAPPING,
    });

    if (response.isError) {
      expect(response.content[0].text).toContain('not indexed');
      return;
    }

    const result = JSON.parse(response.content[0].text);
    expect(result.results).toBeDefined();
  }, 30000);

  it('should filter by entry type', async () => {
    const response = await handleSearchModIndexed({
      query: 'update',
      modId: 'meteor-client',
      modVersion: '0.5.9',
      mapping: TEST_MAPPING,
      types: ['method'],
    });

    if (response.isError) {
      expect(response.content[0].text).toContain('not indexed');
      return;
    }

    const result = JSON.parse(response.content[0].text);
    expect(result.results).toBeDefined();
    // All results should be methods
    result.results.forEach((r: { entryType: string }) => {
      expect(r.entryType).toBe('method');
    });
  }, 30000);
});

/**
 * Minecraft-version auto-detection for `remap_mod_jar`.
 *
 * Version ranges in mod metadata are wildly varied, and the previous
 * implementation stripped `><=~^` characters — which left `[1.16.5,1.17)` and
 * `1.21.10 || 1.21.9` intact and passed them straight into mapping lookup.
 */
describe('extractConcreteVersion', () => {
  it('reads a plain version', () => {
    expect(extractConcreteVersion('1.12.2')).toBe('1.12.2');
  });

  it('strips comparison operators', () => {
    expect(extractConcreteVersion('>=1.21.0')).toBe('1.21.0');
    expect(extractConcreteVersion('>=0.17.3')).toBe('0.17.3');
  });

  it('reads the lower bound of a half-open Maven range', () => {
    // The old implementation returned "[1.16.5,1.17)" unchanged.
    expect(extractConcreteVersion('[1.16.5,1.17)')).toBe('1.16.5');
    expect(extractConcreteVersion('[1.12,1.13)')).toBe('1.12');
  });

  it('takes the first version of an OR list', () => {
    expect(extractConcreteVersion('1.21.10 || 1.21.9')).toBe('1.21.10');
  });

  it('returns undefined when there is no version to read', () => {
    expect(extractConcreteVersion('*')).toBeUndefined();
    expect(extractConcreteVersion('')).toBeUndefined();
    expect(extractConcreteVersion(undefined)).toBeUndefined();
  });
});

/**
 * `decompile_mod_jar` must refuse a mod it could not identify.
 *
 * Before this, an unidentified mod was decompiled into
 * `decompiled-mods/unknown/0.0.0/<mapping>` — ONE directory shared by every
 * such mod. The next unidentified mod hit that cache and was handed a different
 * mod's source with no error.
 */
describe('MCP Tool: decompile_mod_jar without detectable metadata', () => {
  it('fails with actionable instructions instead of using a shared placeholder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mod-decompile-'));
    const jarPath = join(dir, 'mystery-mod.jar');
    const zip = new AdmZip();
    zip.addFile('readme.txt', Buffer.from('no metadata here', 'utf8'));
    writeFileSync(jarPath, zip.toBuffer());

    try {
      const response = await handleDecompileModJar({ jarPath, mapping: 'mcp' });

      expect(response.isError).toBe(true);
      const text = response.content[0].text;
      expect(text).toMatch(/modId/);
      expect(text).toMatch(/modVersion/);
      expect(text).toMatch(/placeholder/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('search_mod_code hit classification (AST-based, shared helper)', () => {
  // A mod-shaped source (a Meteor-style Module) exercising the same AST
  // classification used by search_mod_code. No decompiled mod cache or Java
  // runtime is required — this tests the shared `classifySearchHits` helper
  // directly. Line numbers are pinned by the array layout.
  const source = [
    '// mod header TARGET note', // 1  — no enclosing declaration -> 'content'
    'package com.example.mymod;', // 2
    '', // 3
    'import java.util.Map;', // 4
    '', // 5
    'public class Module {', // 6  — class
    '    private java.util.Map<String, Integer> settings;', // 7 — field (generic)
    '', // 8
    '    void onActivate() {', // 9 — method (package-private)
    '        int count = settings.size();', // 10 — inside onActivate body
    '        System.out.println("TARGET activate");', // 11 — inside body
    '    }', // 12
    '', // 13
    '    @Override', // 14 — annotation line of a multi-line declaration
    '    public String getName() {', // 15 — method (signature on next line)
    '        return "TARGET name";', // 16 — inside getName body
    '    }', // 17
    '}', // 18
  ].join('\n');

  it('classifies a header comment (no enclosing declaration) as content', () => {
    expect(classifySearchHits(source, [1]).get(1)).toBe('content');
  });

  it('classifies a generic/qualified-type field that the dotted-type regex missed', () => {
    expect(classifySearchHits(source, [7]).get(7)).toBe('field');
  });

  it('classifies a package-private method that the access-modifier regex missed', () => {
    expect(classifySearchHits(source, [9]).get(9)).toBe('method');
  });

  it('classifies a hit inside a method body as the enclosing method', () => {
    expect(classifySearchHits(source, [10]).get(10)).toBe('method');
    expect(classifySearchHits(source, [11]).get(11)).toBe('method');
  });

  it('classifies a hit on a multi-line declaration annotation line as method', () => {
    expect(classifySearchHits(source, [14]).get(14)).toBe('method');
  });
});
