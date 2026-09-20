/**
 * `META-INF/MANIFEST.MF` parser.
 *
 * Mod JARs carry far more loader metadata in the manifest than the mod loader's
 * own metadata file exposes, and for legacy Forge (pre-1.13) it is often the
 * ONLY place certain facts live:
 *
 * - `MixinConfigs` — the authoritative list of mixin configs. Legacy mods
 *   (MixinBooter on 1.12.2/1.7.10) name them anything (`mixins.betterf1.json`,
 *   `DistantHorizons.forge.mixins.json`), so a `*.mixins.json` filename scan is
 *   not enough.
 * - `FMLAT` — the access transformer files, which on 1.7.10–1.12.2 use SRG
 *   member names (`field_71428_T`).
 * - `FMLCorePlugin` / `TweakClass` / `Main-Class` — entry points for legacy
 *   coremods and tweakers, which have no `mods.toml` equivalent.
 * - `Implementation-Version` / `Implementation-Title` — last-resort id/version
 *   fallbacks for jars whose metadata file is absent (gradle `-dev` jars).
 *
 * Manifest rules implemented (java.util.jar.Manifest):
 * - Sections are separated by a blank line; the first section is the main
 *   attributes, later sections are named entries.
 * - A line beginning with a single space continues the previous line's value;
 *   the newline and the leading space are removed entirely.
 * - Attribute names are case-insensitive.
 */

/** Attribute map keyed by LOWERCASED attribute name. */
export type ManifestAttributes = Map<string, string>;

export interface JarManifest {
  /** Main attributes (the first section). */
  main: ManifestAttributes;
  /** Named entry sections (e.g. signing metadata). Rarely needed. */
  sections: ManifestAttributes[];
}

/** Case-insensitive attribute lookup. */
export function getManifestAttribute(
  attributes: ManifestAttributes,
  name: string,
): string | undefined {
  return attributes.get(name.toLowerCase());
}

/**
 * Split a manifest attribute that holds a list of file names. Forge's `FMLAT`
 * uses spaces or commas, Mixin's `MixinConfigs` uses commas — and jars in the
 * wild mix both — so split on either and drop empties.
 */
export function splitManifestList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Unfold physical manifest lines (continuations start with a single space). */
function unfoldLines(content: string): string[] {
  const logical: string[] = [];
  for (const physical of content.split(/\r?\n/)) {
    if (physical.startsWith(' ') && logical.length > 0) {
      // Continuation: the leading space and the line break are dropped.
      logical[logical.length - 1] += physical.slice(1);
      continue;
    }
    logical.push(physical);
  }
  return logical;
}

/**
 * Parse a JAR manifest. Malformed lines (no `: ` separator) are skipped rather
 * than thrown on — a broken manifest must not sink the whole analysis.
 */
export function parseJarManifest(content: string): JarManifest {
  const main: ManifestAttributes = new Map();
  const sections: ManifestAttributes[] = [];

  let current: ManifestAttributes = main;
  let started = false;

  for (const line of unfoldLines(content)) {
    if (line.trim() === '') {
      // Blank line ends the current section; the next non-blank line starts a
      // new one (unless we have not written anything yet, i.e. leading blanks).
      if (started) {
        current = new Map();
        sections.push(current);
        started = false;
      }
      continue;
    }

    const colon = line.indexOf(':');
    if (colon <= 0) continue; // not an attribute line

    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!name) continue;

    current.set(name.toLowerCase(), value);
    started = true;
  }

  // Drop trailing empty sections produced by a trailing blank line.
  return { main, sections: sections.filter((section) => section.size > 0) };
}
