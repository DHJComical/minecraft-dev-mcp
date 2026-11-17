import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_NAME_CHAR,
  hasPlaceholderDebugNames,
  treeHasPlaceholderNames,
} from '../../src/utils/debug-names.js';

/** Mojang's placeholder, as it appears in a class file's constant pool. */
const PLACEHOLDER = Buffer.from(PLACEHOLDER_NAME_CHAR, 'utf8');

function makeClassJar(outPath: string, classCount: number, placeholderCount: number): void {
  const zip = new AdmZip();
  for (let i = 0; i < classCount; i++) {
    // A realistic-enough class body: the placeholder sits in a name constant.
    const body = Buffer.concat([
      Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34]),
      i < placeholderCount
        ? Buffer.concat([Buffer.from([0x01, 0x00, 0x03]), PLACEHOLDER])
        : Buffer.alloc(0),
    ]);
    zip.addFile(`pkg/Class${i}.class`, body);
  }
  zip.writeZip(outPath);
}

describe('debug-names', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'debug-names-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('hasPlaceholderDebugNames', () => {
    it('detects the placeholder when most classes carry it', () => {
      const jar = join(workDir, 'obfuscated.jar');
      makeClassJar(jar, 10, 8);
      expect(hasPlaceholderDebugNames(jar)).toBe(true);
    });

    it('reports a clean JAR as clean', () => {
      const jar = join(workDir, 'clean.jar');
      makeClassJar(jar, 10, 0);
      expect(hasPlaceholderDebugNames(jar)).toBe(false);
    });

    it('ignores an incidental occurrence in a large JAR', () => {
      // 1.21.x carries the character in ~1 class out of thousands; treating
      // that as a placeholder JAR would degrade names for every modern version.
      const jar = join(workDir, 'modern.jar');
      makeClassJar(jar, 100, 1);
      expect(hasPlaceholderDebugNames(jar)).toBe(false);
    });

    it('respects the ratio threshold at the boundary', () => {
      const atThreshold = join(workDir, 'threshold.jar');
      makeClassJar(atThreshold, 10, 2);
      expect(hasPlaceholderDebugNames(atThreshold)).toBe(true);

      const belowThreshold = join(workDir, 'below.jar');
      makeClassJar(belowThreshold, 10, 1);
      expect(hasPlaceholderDebugNames(belowThreshold)).toBe(false);
    });

    it('requires every class to be affected below the minimum sample size', () => {
      const all = join(workDir, 'tiny-all.jar');
      makeClassJar(all, 2, 2);
      expect(hasPlaceholderDebugNames(all)).toBe(true);

      const some = join(workDir, 'tiny-some.jar');
      makeClassJar(some, 2, 1);
      expect(hasPlaceholderDebugNames(some)).toBe(false);
    });

    it('returns false for JARs without classes or that cannot be read', () => {
      const empty = join(workDir, 'empty.jar');
      makeClassJar(empty, 0, 0);
      expect(hasPlaceholderDebugNames(empty)).toBe(false);
      expect(hasPlaceholderDebugNames(join(workDir, 'missing.jar'))).toBe(false);
    });
  });

  describe('treeHasPlaceholderNames', () => {
    it('finds placeholder identifiers in decompiled sources', () => {
      const src = join(workDir, 'src');
      mkdirSync(join(src, 'net/minecraft'), { recursive: true });
      writeFileSync(
        join(src, 'net/minecraft/Block.java'),
        'public class Block {\n  void m() { boolean \u2603xxx = false; }\n}\n',
      );
      expect(treeHasPlaceholderNames(src)).toBe(true);
    });

    it('reports a readable tree as clean', () => {
      const src = join(workDir, 'clean-src');
      mkdirSync(join(src, 'net/minecraft'), { recursive: true });
      writeFileSync(
        join(src, 'net/minecraft/Block.java'),
        'public class Block {\n  void m(Block block) { boolean flag = false; }\n}\n',
      );
      expect(treeHasPlaceholderNames(src)).toBe(false);
    });

    it('returns false for an empty or missing directory', () => {
      const emptyDir = join(workDir, 'nothing');
      mkdirSync(emptyDir);
      expect(treeHasPlaceholderNames(emptyDir)).toBe(false);
      expect(treeHasPlaceholderNames(join(workDir, 'does-not-exist'))).toBe(false);
    });

    it('stops scanning after the file budget', () => {
      const src = join(workDir, 'budget');
      mkdirSync(src, { recursive: true });
      // Placeholder only in the last of more files than the budget allows.
      for (let i = 0; i < 5; i++) {
        writeFileSync(
          join(src, `F${i}.java`),
          i === 4 ? 'class F { boolean \u2603x; }' : 'class F { boolean flag; }',
        );
      }
      expect(treeHasPlaceholderNames(src, { maxFiles: 2 })).toBe(false);
      expect(treeHasPlaceholderNames(src, { maxFiles: 10 })).toBe(true);
    });
  });
});
