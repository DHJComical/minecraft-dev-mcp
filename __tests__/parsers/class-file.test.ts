import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import {
  accessFlagNames,
  extractMixinTargets,
  extractModAnnotationId,
  hasModAnnotation,
  isCoremodClass,
  parseClassFile,
} from '../../src/parsers/class-file.js';
import { METEOR_JAR_PATH } from '../test-constants.js';

/**
 * Dependency-free `.class` reader tests.
 *
 * The fixture JAR is compiled from `__tests__/fixtures/legacy-forge-src` and
 * committed, so these run without a JDK. The Mixin stub there is CLASS-retention
 * on purpose (as the real annotation is), which is what makes the
 * `RuntimeInvisibleAnnotations` case a genuine regression test.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_JAR = join(__dirname, '..', 'fixtures', 'legacy-forge-1.12.2.jar');

function readClass(jarPath: string, entryName: string) {
  const zip = new AdmZip(jarPath);
  const entry = zip.getEntry(entryName);
  if (!entry) throw new Error(`Fixture entry missing: ${entryName}`);
  return parseClassFile(entry.getData());
}

describe('parseClassFile', () => {
  it('returns null for bytes that are not a class file', () => {
    expect(parseClassFile(Buffer.from('not a class'))).toBeNull();
    expect(parseClassFile(Buffer.alloc(0))).toBeNull();
  });

  it('reads class shape', () => {
    const info = readClass(FIXTURE_JAR, 'com/example/legacy/LegacyMod.class');
    expect(info?.className).toBe('com.example.legacy.LegacyMod');
    expect(info?.superName).toBe('java.lang.Object');
    expect(info?.isInterface).toBe(false);
    expect(info?.methodCount).toBeGreaterThan(0);
  });

  it('detects an annotation type', () => {
    const info = readClass(FIXTURE_JAR, 'net/minecraftforge/fml/common/Mod.class');
    expect(info?.isInterface).toBe(true);
    expect(info?.isAnnotation).toBe(true);
  });

  it('reports access flags in the documented order', () => {
    const info = readClass(
      FIXTURE_JAR,
      'net/minecraftforge/fml/relauncher/IFMLLoadingPlugin.class',
    );
    expect(info).not.toBeNull();
    expect(accessFlagNames(info?.accessFlags ?? 0)).toContain('interface');
    expect(accessFlagNames(0)).toEqual([]);
  });
});

describe('Forge @Mod detection', () => {
  it('finds @Mod and reads the legacy `modid` element', () => {
    // Forge 1.8+ uses `value`; 1.7.10 used `modid`. Both must work.
    const info = readClass(FIXTURE_JAR, 'com/example/legacy/LegacyMod.class');
    expect(info && hasModAnnotation(info)).toBe(true);
    expect(info && extractModAnnotationId(info)).toBe('legacymod');
  });

  it('does not treat an ordinary class as a mod', () => {
    const info = readClass(FIXTURE_JAR, 'com/example/legacy/LegacyCorePlugin.class');
    expect(info && hasModAnnotation(info)).toBe(false);
    expect(info && extractModAnnotationId(info)).toBeUndefined();
  });
});

describe('legacy coremod detection', () => {
  it('recognises a class implementing IFMLLoadingPlugin', () => {
    // The interface IS the declaration — no metadata file names this class.
    const info = readClass(FIXTURE_JAR, 'com/example/legacy/LegacyCorePlugin.class');
    expect(info && isCoremodClass(info)).toBe(true);
  });

  it('does not flag a plain class', () => {
    const info = readClass(FIXTURE_JAR, 'com/example/legacy/LegacyMod.class');
    expect(info && isCoremodClass(info)).toBe(false);
  });
});

describe('@Mixin target extraction', () => {
  it('reads `targets` (a string array)', () => {
    const info = readClass(FIXTURE_JAR, 'com/example/legacy/mixin/WorldMixin.class');
    expect(info && extractMixinTargets(info)).toEqual(['net.minecraft.world.World']);
  });

  it('decodes a class literal (`value`) out of its L...; descriptor', () => {
    const info = readClass(FIXTURE_JAR, 'com/example/legacy/mixin/AliasMixin.class');
    // `@Mixin(WorldMixin.class)` stores a descriptor; leaking the `L`/`;`
    // wrapper or the array form is the failure this pins down.
    expect(info && extractMixinTargets(info)).toEqual(['com.example.legacy.mixin.WorldMixin']);
  });

  it('reads @Mixin from RuntimeInvisibleAnnotations (CLASS retention)', () => {
    // Mixin's @Mixin is RetentionPolicy.CLASS. A reader that only looks at
    // RuntimeVisibleAnnotations returns nothing here.
    const info = readClass(FIXTURE_JAR, 'com/example/legacy/mixin/WorldMixin.class');
    expect(info?.annotations.map((a) => a.descriptor)).toContain(
      'Lorg/spongepowered/asm/mixin/Mixin;',
    );
  });

  it('returns targets in the JAR’s own name space (intermediary for Fabric)', () => {
    // Meteor is a Fabric mod: the compiled class literal is intermediary, and
    // translating it needs a Minecraft version, which analysis does not have.
    const info = readClass(
      METEOR_JAR_PATH,
      'meteordevelopment/meteorclient/mixin/ClientWorldMixin.class',
    );
    const targets = (info && extractMixinTargets(info)) ?? [];
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatch(/^net\.minecraft\./);
  });

  it('returns no targets for a class without @Mixin', () => {
    const info = readClass(FIXTURE_JAR, 'com/example/legacy/LegacyMod.class');
    expect(info && extractMixinTargets(info)).toEqual([]);
  });
});
