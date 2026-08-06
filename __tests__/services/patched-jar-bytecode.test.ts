import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';
import { getDatabase } from '../../src/cache/database.js';
import { getAccessTransformerService } from '../../src/services/access-transformer-service.js';
import { bytecodeUnavailableMessage } from '../../src/services/bytecode-index-service.js';
import { DecompileService } from '../../src/services/decompile-service.js';
import { ensureDir } from '../../src/utils/file-utils.js';
import { getDecompiledPath, getRemappedJarPath } from '../../src/utils/paths.js';

/**
 * Patched Forge/NeoForge JARs must stay validatable after the switch to
 * bytecode ground truth.
 *
 * The bytecode validators gate on `hasRemappedJar`, but the patched-JAR flow
 * (`decompileLocalJar`) does no remapping — so unless the input JAR is
 * registered as that version key's remapped JAR, `validate_access_transformer`
 * tells a NeoForge user to "run decompile_minecraft_version first" immediately
 * after they did exactly that. These tests pin the registration and the
 * sources-JAR fallback message.
 *
 * Deliberately Java-free: the branches exercised here (already-decompiled
 * backfill, sources extraction) never invoke VineFlower, so this runs in default
 * CI. The full compiled decompile → register → validate round trip lives in the
 * manual patched suite.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_JAR = join(__dirname, '..', 'fixtures', 'summoningrituals-mc-stubs.jar');
const DUMPER_JAR = join(
  __dirname,
  '..',
  '..',
  'tools',
  'bytecode-dumper',
  'build',
  'libs',
  'bytecode-dumper-1.0.0.jar',
);
// Only the round-trip validation needs the ASM dumper (and thus Java); the
// registration and message tests are pure filesystem.
const itWithDumper = existsSync(DUMPER_JAR) ? it : it.skip;

// Conventional patched cache key (`<mc>-<loader>-<loaderVersion>`) — the point
// is that an opaque key flows through the bytecode path like any vanilla one.
const PATCHED_VERSION = '0.0.0-neoforge-patched-test';
const MAPPING = 'mojmap' as const;

describe('patched JAR bytecode availability (Forge/NeoForge)', () => {
  const staged: string[] = [];
  const versions = new Set<string>();

  function track(path: string): string {
    staged.push(path);
    return path;
  }

  afterEach(() => {
    for (const path of staged.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
    // decompileLocalJar writes a decompile_jobs row; drop it so these throwaway
    // keys don't accumulate in the shared cache DB.
    for (const version of versions) {
      try {
        getDatabase().deleteJob(version, MAPPING);
      } catch {
        // best-effort
      }
    }
    versions.clear();
  });

  /**
   * Track the whole `decompiled/{version}` tree, not just the mapping subdir —
   * removing only the latter leaves an empty version folder behind in the real
   * shared cache.
   */
  function trackDecompiledTree(version: string): string {
    const mappingDir = getDecompiledPath(version, MAPPING);
    track(dirname(mappingDir));
    return mappingDir;
  }

  /** Pretend this version key was already decompiled (no VineFlower needed). */
  function stageDecompiledSource(version: string): void {
    versions.add(version);
    const dir = trackDecompiledTree(version);
    mkdirSync(join(dir, 'net', 'minecraft'), { recursive: true });
    writeFileSync(join(dir, 'net', 'minecraft', 'Marker.java'), 'class Marker {}\n', 'utf8');
  }

  /** A sources-only JAR, as NFRT/ForgeGradle `-sources.jar` produces. */
  function makeSourcesJar(): string {
    const zip = new AdmZip();
    zip.addFile('net/minecraft/Foo.java', Buffer.from('package net.minecraft;\nclass Foo {}\n'));
    const path = track(join(dirname(FIXTURE_JAR), 'tmp-patched-sources.jar'));
    zip.writeZip(path);
    return path;
  }

  it("registers a compiled patched JAR as the version key's remapped JAR", async () => {
    stageDecompiledSource(PATCHED_VERSION);
    const remapped = track(getRemappedJarPath(PATCHED_VERSION, MAPPING));
    ensureDir(dirname(remapped));
    rmSync(remapped, { force: true });

    // Source tree already present -> the "already decompiled" fast path, which
    // must still backfill the remapped JAR (caches built before this existed).
    const result = await new DecompileService().decompileLocalJar(
      FIXTURE_JAR,
      PATCHED_VERSION,
      MAPPING,
    );

    expect(result.mode).toBe('decompiled');
    expect(existsSync(remapped)).toBe(true);
    // It is the patched JAR itself — no remapping happens in this flow.
    expect(new AdmZip(remapped).getEntries().length).toBe(
      new AdmZip(FIXTURE_JAR).getEntries().length,
    );
  });

  itWithDumper(
    'validates an access transformer against a patched version key end to end',
    async () => {
      // Registration is what makes this work: stage the JAR exactly where
      // decompileLocalJar puts it, then validate using the opaque patched key.
      const remapped = track(getRemappedJarPath(PATCHED_VERSION, MAPPING));
      ensureDir(dirname(remapped));
      copyFileSync(FIXTURE_JAR, remapped);
      track(remapped.replace(/\.jar$/i, '.bytecode.json'));

      const svc = getAccessTransformerService();
      const at = svc.parseAccessTransformer(
        'public net.minecraft.world.level.storage.loot.IntRange\n',
      );
      const validation = await svc.validateAccessTransformer(at, PATCHED_VERSION, MAPPING);

      // The pre-fix behaviour was a hard "not available locally" error here.
      expect(validation.errors.map((e) => e.message)).toEqual([]);
      expect(validation.isValid).toBe(true);
    },
    60000,
  );

  it('does not register a sources JAR and explains why validation is unavailable', async () => {
    const version = `${PATCHED_VERSION}-sources`;
    versions.add(version);
    const sourcesJar = makeSourcesJar();
    trackDecompiledTree(version);
    const remapped = track(getRemappedJarPath(version, MAPPING));

    const result = await new DecompileService().decompileLocalJar(sourcesJar, version, MAPPING);

    expect(result.mode).toBe('extracted');
    // Nothing to register — a sources JAR has no bytecode at all.
    expect(existsSync(remapped)).toBe(false);

    // The user must NOT be told to re-run decompile: they already did, and
    // re-running cannot produce bytecode from a sources JAR.
    const message = bytecodeUnavailableMessage(version, MAPPING);
    expect(message).toContain('sources JAR');
    expect(message).not.toContain('Run decompile_minecraft_version first');

    const svc = getAccessTransformerService();
    const at = svc.parseAccessTransformer('public net.minecraft.Foo\n');
    const validation = await svc.validateAccessTransformer(at, version, MAPPING);
    expect(validation.isValid).toBe(false);
    expect(validation.errors[0]?.message).toBe(message);
  });

  it('still says "run decompile first" when the version was never processed', () => {
    const message = bytecodeUnavailableMessage('0.0.0-never-processed', MAPPING);
    expect(message).toContain('Run decompile_minecraft_version first');
    expect(message).not.toContain('sources JAR');
  });
});
