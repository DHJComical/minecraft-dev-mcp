/**
 * Test constants for the legacy third-party mod suite.
 *
 * Driven entirely by environment variables so the same suite covers any
 * pre-1.14 Forge mod layout (mcmod.info on 1.6.4-1.12.2, mods.toml on 1.13.x).
 * Skipped cleanly when unset — no CI job depends on a specific third-party mod.
 *
 * Required:
 *   LEGACY_MOD_JAR      Absolute path to the mod JAR (original, unremapped)
 *
 * Optional:
 *   LEGACY_MOD_MC       Minecraft version the mod targets (e.g. 1.12.2).
 *                       When unset the suite asserts that analyze_mod_jar
 *                       recovers it from the mod metadata itself.
 *   LEGACY_MOD_MAPPING  Mapping to remap/decompile with (default: mcp)
 *   LEGACY_MOD_ID       Expected mod id (default: whatever analysis reports)
 *   LEGACY_MOD_VERSION  Expected mod version (default: whatever analysis reports)
 *   LEGACY_MOD_AT       Absolute path to the mod's access transformer .cfg,
 *                       to exercise SRG member-name resolution (1.7.10-1.16)
 */

export const LEGACY_MOD_JAR = process.env.LEGACY_MOD_JAR ?? '';
export const LEGACY_MOD_MC = process.env.LEGACY_MOD_MC ?? '';
export const LEGACY_MOD_MAPPING = (process.env.LEGACY_MOD_MAPPING ?? 'mcp') as 'mcp' | 'feather';
export const LEGACY_MOD_ID = process.env.LEGACY_MOD_ID ?? '';
export const LEGACY_MOD_VERSION = process.env.LEGACY_MOD_VERSION ?? '';
export const LEGACY_MOD_AT = process.env.LEGACY_MOD_AT ?? '';

/** True when the suite has something real to run against. */
export const HAS_LEGACY_MOD = LEGACY_MOD_JAR !== '';
