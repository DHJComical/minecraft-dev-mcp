import type { Dirent } from 'node:fs';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { logger } from './logger.js';

/**
 * Obfuscated Minecraft JARs carry debug information, but Mojang replaces every
 * parameter and local-variable name with the U+2603 SNOWMAN character instead of
 * stripping it. All names in a class therefore resolve to the same constant pool
 * entry, and a decompiler that honours `LocalVariableTable` / `MethodParameters`
 * emits a wall of `U+2603xxxx…` identifiers that is neither readable nor
 * compilable (duplicate names are uniquified by appending `x`).
 *
 * These helpers detect that placeholder so callers can fall back to a
 * type-derived renamer (`--variable-renaming=jad`) or re-decompile a cache
 * produced before the fallback existed.
 */
export const PLACEHOLDER_NAME_CHAR = '\u2603';

/** UTF-8 form of {@link PLACEHOLDER_NAME_CHAR}; identical to the JVM's modified UTF-8 for U+2603. */
const PLACEHOLDER_BYTES = Buffer.from(PLACEHOLDER_NAME_CHAR, 'utf8');

export interface PlaceholderDetectionOptions {
  /** Maximum number of class entries to inspect. Defaults to 200. */
  sampleSize?: number;
  /** Share of sampled classes that must be affected. Defaults to 0.2. */
  threshold?: number;
  /**
   * Minimum sample size for {@link threshold} to apply. Below this, every
   * sampled class must be affected. Defaults to 5.
   */
  minClasses?: number;
}

/**
 * Decide whether a JAR's debug-name tables are Mojang's placeholder garbage.
 *
 * Samples up to `sampleSize` class entries (sorted by name, so the verdict is
 * deterministic) and counts those containing the placeholder character. Sampling
 * keeps this cheap: decompiling a version takes minutes, while this check takes
 * milliseconds. Real collisions are negligible — 1.21.x contains it in a single
 * incidental class out of thousands, while the affected eras carry it in ~99% of
 * classes.
 */
export function hasPlaceholderDebugNames(
  jarPath: string,
  options: PlaceholderDetectionOptions = {},
): boolean {
  const { sampleSize = 200, threshold = 0.2, minClasses = 5 } = options;

  let classEntries: AdmZip.IZipEntry[];
  try {
    const zip = new AdmZip(jarPath);
    classEntries = zip
      .getEntries()
      .filter((entry) => !entry.isDirectory && entry.entryName.endsWith('.class'));
  } catch (error) {
    logger.warn(`Could not inspect ${jarPath} for placeholder debug names: ${String(error)}`);
    return false;
  }

  if (classEntries.length === 0) return false;

  // Deterministic sample: the same JAR always yields the same verdict.
  classEntries.sort((a, b) => a.entryName.localeCompare(b.entryName));
  const sample = classEntries.slice(0, sampleSize);

  let affected = 0;
  for (const entry of sample) {
    let data: Buffer;
    try {
      data = entry.getData();
    } catch {
      continue;
    }
    if (data.includes(PLACEHOLDER_BYTES)) {
      affected++;
    }
  }

  const sampled = sample.length;
  if (sampled === 0) return false;
  // Tiny JARs (a single-class mod, a test fixture) never reach the ratio
  // threshold, so require every sampled class to be affected instead.
  if (sampled < minClasses) return affected === sampled;

  return affected / sampled >= threshold;
}

/**
 * Scan a decompiled source tree for placeholder identifiers.
 *
 * Used to decide whether a cache written by an older version of this server
 * needs rebuilding: a clean tree contains no U+2603 at all, while a broken one is
 * affected almost everywhere, so the scan stops at the first hit.
 */
export function treeHasPlaceholderNames(
  sourceDir: string,
  options: { maxFiles?: number } = {},
): boolean {
  const { maxFiles = 200 } = options;
  let inspected = 0;

  const walk = (dir: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (inspected >= maxFiles) return false;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(fullPath)) return true;
        continue;
      }
      if (!entry.name.endsWith('.java')) continue;
      inspected++;
      try {
        if (readFileSync(fullPath, 'utf8').includes(PLACEHOLDER_NAME_CHAR)) return true;
      } catch {
        // Unreadable file: skip rather than treating it as a hit.
      }
    }
    return false;
  };

  return walk(sourceDir);
}
