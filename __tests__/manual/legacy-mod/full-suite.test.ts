import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCacheManager } from '../../../src/cache/cache-manager.js';
import {
  handleDecompileModJar,
  handleRemapModJar,
  handleValidateAccessTransformer,
} from '../../../src/server/tools.js';
import { getModAnalyzerService } from '../../../src/services/mod-analyzer-service.js';
import {
  HAS_LEGACY_MOD,
  LEGACY_MOD_AT,
  LEGACY_MOD_ID,
  LEGACY_MOD_JAR,
  LEGACY_MOD_MAPPING,
  LEGACY_MOD_MC,
  LEGACY_MOD_VERSION,
} from './test-constants.js';

/**
 * Legacy third-party mod E2E suite (pre-1.14 Forge).
 *
 * Covers the whole mod pipeline for a mod whose metadata format and member
 * naming predate everything the tool was originally built for:
 *
 *   1. `analyze_mod_jar` reads `mcmod.info` (not `mods.toml`), so the mod has a
 *      real id/version/Minecraft version instead of `unknown` / `0.0.0`
 *   2. `remap_mod_jar` auto-detects the loader (forge) and Minecraft version,
 *      and remaps SRG member names to MCP names
 *   3. `decompile_mod_jar` caches under the mod's real identity
 *   4. an SRG-named access transformer validates against MCP-named bytecode
 *
 * Skipped when LEGACY_MOD_JAR is unset. Example:
 *
 *   LEGACY_MOD_JAR=/mods/StorageDrawers-1.12.2-5.5.3.jar \
 *   LEGACY_MOD_MC=1.12.2 \
 *   LEGACY_MOD_ID=storagedrawers \
 *   npm run test:manual:legacy-mod
 */

const describeIfMod = HAS_LEGACY_MOD && existsSync(LEGACY_MOD_JAR) ? describe : describe.skip;

describeIfMod('legacy Forge mod pipeline', () => {
  const analyzer = getModAnalyzerService();

  it('analyzes legacy metadata instead of reporting unknown/0.0.0', async () => {
    const result = await analyzer.analyzeMod(LEGACY_MOD_JAR);

    expect(result.loader).toBe('forge');
    expect(result.metadata.id).not.toBe('unknown');
    expect(result.metadata.version).not.toBe('0.0.0');

    if (LEGACY_MOD_ID) expect(result.metadata.id).toBe(LEGACY_MOD_ID);
    if (LEGACY_MOD_VERSION) expect(result.metadata.version).toBe(LEGACY_MOD_VERSION);

    // `mcversion` (mcmod.info) or a mods.toml dependency must have supplied this.
    if (LEGACY_MOD_MC) {
      expect(result.compatibility.minecraft).toContain(LEGACY_MOD_MC);
    } else {
      expect(result.compatibility.minecraft).not.toBe('*');
    }
  }, 120000);

  it('remaps the mod to readable names, auto-detecting loader and version', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'legacy-mod-remap-'));
    const outputJar = join(outputDir, 'remapped.jar');

    try {
      const response = await handleRemapModJar({
        inputJar: LEGACY_MOD_JAR,
        outputJar,
        toMapping: LEGACY_MOD_MAPPING,
      });

      expect(response.isError).toBeUndefined();
      const result = JSON.parse(response.content[0].text);
      expect(result.success).toBe(true);
      expect(result.loader).toBe('forge');
      if (LEGACY_MOD_MC) expect(result.mcVersion).toBe(LEGACY_MOD_MC);
      expect(existsSync(outputJar)).toBe(true);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  }, 600000);

  it('decompiles the mod under its detected identity', async () => {
    const response = await handleDecompileModJar({
      jarPath: LEGACY_MOD_JAR,
      mapping: LEGACY_MOD_MAPPING,
    });

    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.modId).not.toBe('unknown');
    expect(result.modVersion).not.toBe('0.0.0');
    if (LEGACY_MOD_ID) expect(result.modId).toBe(LEGACY_MOD_ID);
  }, 900000);

  it('resolves SRG member names when validating a legacy access transformer', async () => {
    if (!LEGACY_MOD_AT || !LEGACY_MOD_MC) {
      console.warn('LEGACY_MOD_AT / LEGACY_MOD_MC not set — skipping AT check');
      return;
    }
    // Validation reads the REMAPPED Minecraft JAR's bytecode, which
    // decompile_minecraft_version produces.
    if (!getCacheManager().hasRemappedJar(LEGACY_MOD_MC, LEGACY_MOD_MAPPING)) {
      console.warn(
        `${LEGACY_MOD_MC}/${LEGACY_MOD_MAPPING} is not decompiled yet — run decompile_minecraft_version first, skipping AT check`,
      );
      return;
    }

    const response = await handleValidateAccessTransformer({
      content: LEGACY_MOD_AT,
      mcVersion: LEGACY_MOD_MC,
      mapping: LEGACY_MOD_MAPPING,
    });

    expect(response.isError).toBeUndefined();
    const result = JSON.parse(response.content[0].text);
    // The point of the check: SRG ids must NOT come back as "member not found".
    const messages = [
      ...(result.errors ?? []).map((e: { message: string }) => e.message),
      ...(result.warnings ?? []).map((w: { message: string }) => w.message),
    ].join(' ');
    expect(messages).not.toMatch(/Field 'field_\d+_\w+' not found/);
    expect(messages).not.toMatch(/Method 'func_\d+_\w+' not found/);
  }, 600000);
});
