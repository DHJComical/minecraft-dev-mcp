/**
 * Legacy Forge `mcmod.info` parser (Minecraft 1.6.4 – 1.12.2).
 *
 * Before 1.13, Forge mods declared themselves in a root-level `mcmod.info`
 * JSON file instead of `META-INF/mods.toml`. Anything that only understands
 * `mods.toml` therefore sees every legacy Forge mod as an unidentified jar.
 *
 * Two shapes exist in the wild:
 * - a bare JSON array of mod objects (the common 1.7.10–1.12.2 form), and
 * - an object with a `modList` array (older/loader-written form).
 *
 * Author lists are frequently malformed: `"authorList": ["a, b, c"]` packs
 * several names into one string, so each entry is split on commas.
 */

/** Normalized view of one legacy mod entry. */
export interface LegacyModInfo {
  /** `modid`. */
  modId: string;
  /** `version`. */
  version?: string;
  /** `name` (display name). */
  name?: string;
  /** `description`. */
  description?: string;
  /** `authorList`, comma-split. */
  authors: string[];
  /** `credits`. */
  credits?: string;
  /** `url`. */
  url?: string;
  /** `updateUrl` / `updateJSON`. */
  updateUrl?: string;
  /** `logoFile`. */
  logoFile?: string;
  /** `mcversion` — the Minecraft version the mod was built for. */
  mcVersion?: string;
  /** `acceptedMinecraftVersions` — a Forge version range (1.7.10+). */
  acceptedMinecraftVersions?: string;
  /** `parent` — the parent mod this one attaches to. */
  parent?: string;
  /** `requiredMods` — mods that must be present. */
  requiredMods: string[];
  /** `dependencies` — mods that must load before this one. */
  dependencies: string[];
  /** `dependants` — mods that must load after this one. */
  dependants: string[];
  /**
   * `useDependencyInformation`. When explicitly false, Forge ignores the
   * dependency lists for load-order enforcement, so callers should report them
   * as non-mandatory.
   */
  useDependencyInformation: boolean;
}

/** A raw (unvalidated) mcmod.info entry. */
type RawModEntry = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Normalize an author-ish field that may be a string, a string array, or an
 * array of strings each holding several comma-separated names.
 */
function asNameList(value: unknown): string[] {
  const parts: string[] = [];
  const pushOne = (candidate: unknown): void => {
    if (typeof candidate !== 'string') return;
    for (const name of candidate.split(',')) {
      const trimmed = name.trim();
      if (trimmed) parts.push(trimmed);
    }
  };
  if (Array.isArray(value)) {
    for (const item of value) pushOne(item);
  } else {
    pushOne(value);
  }
  return parts;
}

/** Like `asNameList`, but keeps each entry whole (mod ids have no commas). */
function asIdList(value: unknown): string[] {
  const parts: string[] = [];
  const pushOne = (candidate: unknown): void => {
    if (typeof candidate !== 'string') return;
    const trimmed = candidate.trim();
    if (trimmed) parts.push(trimmed);
  };
  if (Array.isArray(value)) {
    for (const item of value) pushOne(item);
  } else {
    pushOne(value);
  }
  return parts;
}

/**
 * Extract the mod entries from an `mcmod.info` string.
 *
 * Returns an empty array when the file is unparseable or holds no entries; the
 * caller decides whether that is fatal (it usually just means "no metadata").
 */
export function parseMcmodInfo(content: string): LegacyModInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Some 1.6.4-era files carry trailing commas, which JSON.parse rejects.
    try {
      parsed = JSON.parse(content.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      return [];
    }
  }

  const entries: RawModEntry[] = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === 'object') entries.push(item as RawModEntry);
    }
  } else if (parsed && typeof parsed === 'object') {
    const modList = (parsed as { modList?: unknown }).modList;
    if (Array.isArray(modList)) {
      for (const item of modList) {
        if (item && typeof item === 'object') entries.push(item as RawModEntry);
      }
    }
  }

  const result: LegacyModInfo[] = [];
  for (const entry of entries) {
    const modId = asString(entry.modid) ?? asString(entry.modId);
    if (!modId) continue;
    result.push({
      modId,
      version: asString(entry.version),
      name: asString(entry.name),
      description: asString(entry.description),
      authors: asNameList(entry.authorList ?? entry.authors),
      credits: asString(entry.credits),
      url: asString(entry.url),
      updateUrl: asString(entry.updateUrl) ?? asString(entry.updateJSON),
      logoFile: asString(entry.logoFile),
      mcVersion: asString(entry.mcversion) ?? asString(entry.mcVersion),
      acceptedMinecraftVersions: asString(entry.acceptedMinecraftVersions),
      parent: asString(entry.parent),
      requiredMods: asIdList(entry.requiredMods),
      dependencies: asIdList(entry.dependencies),
      dependants: asIdList(entry.dependants),
      useDependencyInformation: entry.useDependencyInformation !== false,
    });
  }

  return result;
}
