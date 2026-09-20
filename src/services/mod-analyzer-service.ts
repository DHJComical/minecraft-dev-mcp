import { existsSync, statSync } from 'node:fs';
import AdmZip from 'adm-zip';
import {
  accessFlagNames,
  extractMixinTargets,
  extractModAnnotationId,
  hasModAnnotation,
  isCoremodClass,
  parseClassFile,
} from '../parsers/class-file.js';
import {
  type JarManifest,
  getManifestAttribute,
  parseJarManifest,
  splitManifestList,
} from '../parsers/jar-manifest.js';
import { parseMcmodInfo } from '../parsers/mcmod-info.js';
import { parseModsToml } from '../parsers/mods-toml.js';
import type {
  DependencyType,
  ModAnalysisResult,
  ModClass,
  ModContact,
  ModDependency,
  ModEntrypoint,
  ModEnvironment,
  ModLoader,
  ModMixinConfig,
  ModPerson,
} from '../types/minecraft.js';
import { logger } from '../utils/logger.js';

/**
 * Mod JAR analysis.
 *
 * Supports every loader generation, which matters because the metadata format
 * changed twice:
 * - Fabric/Quilt: `fabric.mod.json` / `quilt.mod.json` (1.14+)
 * - Forge 1.13 – 1.20.x: `META-INF/mods.toml`; NeoForge 1.20.5+: `neoforge.mods.toml`
 * - Forge 1.6.4 – 1.12.2: `mcmod.info` (JSON)
 *
 * Facts the metadata files do not carry are recovered from `META-INF/MANIFEST.MF`
 * (`MixinConfigs`, `FMLAT`, `FMLCorePlugin`, `TweakClass`, `Implementation-Version`)
 * and from the class files themselves (`@Mod` ids, `@Mixin` targets, legacy
 * coremod interfaces). Without those, a legacy Forge mod's declared mixin
 * configs, access transformers and entry points are invisible, and a gradle
 * `-dev` jar with no metadata file at all cannot be identified.
 */

/**
 * Sentinel mod id used when no loader metadata identified the mod.
 */
export const UNKNOWN_MOD_ID = 'unknown';
/** Sentinel mod version used when no loader metadata declared a version. */
export const UNKNOWN_MOD_VERSION = '0.0.0';

/**
 * Unresolved Gradle placeholder (`${mod_id}`, `${version}`). ForgeGradle and
 * Loom leave these in `mods.toml`/`fabric.mod.json` until `processResources`
 * runs, so they appear in sources and dev jars. They are not real ids: treating
 * them as detected would write a decompiled mod to a directory literally named
 * `${mod_id}`.
 */
const PLACEHOLDER_PATTERN = /\$\{[^}]*\}/;

/** Does a metadata value still contain an unexpanded build placeholder? */
export function isUnresolvedPlaceholder(value: string | undefined): boolean {
  return !!value && PLACEHOLDER_PATTERN.test(value);
}

/**
 * Did the analysis actually identify a mod id? Callers that derive a cache path
 * from it MUST check: `unknown` is a sentinel and `${...}` is a build
 * placeholder, and every unidentified mod would otherwise collide in the same
 * directory.
 */
export function isDetectedModId(id: string | undefined): boolean {
  return !!id && id !== UNKNOWN_MOD_ID && !isUnresolvedPlaceholder(id);
}

/** Did the analysis actually identify a mod version? (`0.0.0` is a sentinel.) */
export function isDetectedModVersion(version: string | undefined): boolean {
  return !!version && version !== UNKNOWN_MOD_VERSION && !isUnresolvedPlaceholder(version);
}

/**
 * Options for mod analysis
 */
export interface ModAnalyzerOptions {
  /** Include all classes in output (can be large) */
  includeAllClasses?: boolean;
  /** Include raw metadata files */
  includeRawMetadata?: boolean;
  /** Analyze bytecode for mixin detection */
  analyzeBytecode?: boolean;
}

/**
 * Fabric mod.json structure
 */
interface FabricModJson {
  schemaVersion: number;
  id: string;
  version: string;
  name?: string;
  description?: string;
  authors?: Array<string | { name: string; contact?: Record<string, string> }>;
  contributors?: Array<string | { name: string; contact?: Record<string, string> }>;
  contact?: Record<string, string>;
  license?: string | string[];
  icon?: string;
  environment?: '*' | 'client' | 'server';
  entrypoints?: Record<string, Array<string | { adapter?: string; value: string }>>;
  mixins?: Array<string | { config: string; environment?: string }>;
  accessWidener?: string;
  depends?: Record<string, string | string[]>;
  recommends?: Record<string, string | string[]>;
  suggests?: Record<string, string | string[]>;
  breaks?: Record<string, string | string[]>;
  conflicts?: Record<string, string | string[]>;
  jars?: Array<{ file: string }>;
  languageAdapters?: Record<string, string>;
  custom?: Record<string, unknown>;
}

/**
 * Quilt mod.json structure (qmj)
 */
interface QuiltModJson {
  schema_version: number;
  quilt_loader: {
    group: string;
    id: string;
    version: string;
    metadata?: {
      name?: string;
      description?: string;
      contributors?: Record<string, string>;
      contact?: Record<string, string>;
      license?: string | string[];
      icon?: string;
    };
    entrypoints?: Record<string, Array<string | { adapter?: string; value: string }>>;
    depends?: Array<{
      id: string;
      versions?: string | string[];
      optional?: boolean;
      reason?: string;
    }>;
    breaks?: Array<{
      id: string;
      versions?: string | string[];
      reason?: string;
    }>;
    provides?: Array<{ id: string; version?: string }>;
    jars?: string[];
    load_type?: 'always' | 'if_possible' | 'if_required';
  };
  mixin?: string | string[];
  access_widener?: string;
  minecraft?: {
    environment?: '*' | 'client' | 'dedicated_server';
  };
}

/**
 * Mixin config JSON structure. Field coverage follows the configs actually
 * shipped by mods; legacy Mixin 0.7 builds (1.7.10/1.12.2) add `minVersion`
 * and `compatibilityLevel`, which are surfaced so an agent can tell a config
 * apart when it targets an older Mixin.
 */
interface MixinConfigJson {
  required?: boolean;
  package?: string;
  compatibilityLevel?: string;
  mixins?: string[];
  client?: string[];
  server?: string[];
  injectors?: {
    defaultRequire?: number;
  };
  refmap?: string;
  minVersion?: string;
  plugin?: string;
  setSourceFile?: boolean;
  verbose?: boolean;
}

/**
 * Metadata extracted from whichever loader-specific source the JAR provides,
 * normalized into one shape. (Previously each parser repeated this 15-field
 * inline type.)
 */
interface ParsedModMetadata {
  id: string;
  version: string;
  name?: string;
  description?: string;
  authors: ModPerson[];
  contributors?: ModPerson[];
  license?: string | string[];
  icon?: string;
  contact?: ModContact;
  minecraft: string;
  loaderVersion?: string;
  javaVersion?: number;
  environment: ModEnvironment;
  dependencies: ModDependency[];
  entrypoints: ModEntrypoint[];
  mixinConfigFiles: string[];
  accessWidener?: string;
  accessTransformers: string[];
  nestedJars?: string[];
  entrypointClasses: string[];
  /** Human-readable notes about anything the metadata did not provide. */
  warnings: string[];
}

/**
 * Service for analyzing third-party mod JARs
 */
export class ModAnalyzerService {
  /**
   * Analyze a mod JAR file
   */
  async analyzeMod(jarPath: string, options: ModAnalyzerOptions = {}): Promise<ModAnalysisResult> {
    const startTime = Date.now();

    // Validate JAR exists
    if (!existsSync(jarPath)) {
      throw new Error(`JAR file not found: ${jarPath}`);
    }

    const jarStats = statSync(jarPath);
    if (!jarStats.isFile()) {
      throw new Error(`Path is not a file: ${jarPath}`);
    }

    logger.info(`Analyzing mod JAR: ${jarPath}`);

    const zip = new AdmZip(jarPath);
    const entries = zip.getEntries();

    const manifest = this.readManifest(zip);

    // Detect mod loader and parse metadata
    const loaderInfo = this.detectModLoader(zip);
    const metadata = this.parseMetadata(zip, loaderInfo.loader, manifest);

    // Mixin configs: loader metadata, then the manifest, then a filename scan.
    metadata.mixinConfigFiles = this.collectMixinConfigs(zip, metadata.mixinConfigFiles, manifest);
    const mixinConfigs = this.parseMixinConfigs(zip, metadata.mixinConfigFiles);

    // Access transformers: manifest + mods.toml + legacy filename conventions.
    metadata.accessTransformers = this.collectAccessTransformers(
      zip,
      metadata.accessTransformers,
      manifest,
    );

    // Analyze classes (also recovers @Mod ids, coremods and mixin targets).
    const classAnalysis = await this.analyzeClasses(
      zip,
      entries,
      metadata.entrypointClasses,
      mixinConfigs,
      options,
    );

    // Fold bytecode discoveries into the metadata: a `@Mod` annotation is the
    // authoritative id for Forge (and the only source for gradle `-dev` jars),
    // and legacy coremods are only identifiable from their interfaces.
    this.applyBytecodeFindings(metadata, classAnalysis);

    // Fall back to the manifest for an id/version the metadata file did not
    // provide, then to the sentinels.
    this.applyManifestFallbacks(metadata, manifest);

    const result: ModAnalysisResult = {
      analysis: {
        jarPath,
        jarSize: jarStats.size,
        analyzedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
      },
      loader: loaderInfo.loader,
      metadata: {
        id: metadata.id,
        version: metadata.version,
        name: metadata.name,
        description: metadata.description,
        authors: metadata.authors,
        contributors: metadata.contributors,
        license: metadata.license,
        icon: metadata.icon,
        contact: metadata.contact,
      },
      compatibility: {
        minecraft: metadata.minecraft,
        loaderVersion: metadata.loaderVersion,
        javaVersion: metadata.javaVersion,
        environment: metadata.environment,
      },
      dependencies: metadata.dependencies,
      entrypoints: metadata.entrypoints,
      mixins: mixinConfigs,
      accessWidener: metadata.accessWidener,
      accessTransformers:
        metadata.accessTransformers.length > 0 ? metadata.accessTransformers : undefined,
      classes: classAnalysis,
      nestedJars: metadata.nestedJars,
      warnings: metadata.warnings.length > 0 ? metadata.warnings : undefined,
    };

    if (options.includeRawMetadata) {
      result.rawMetadata = {
        fabricModJson: loaderInfo.fabricModJson,
        quiltModJson: loaderInfo.quiltModJson,
        mcmodInfo: loaderInfo.mcmodInfo,
        modsToml: loaderInfo.modsToml,
        manifest: Object.fromEntries(manifest.main),
        mixinConfigs: this.getRawMixinConfigs(zip, metadata.mixinConfigFiles),
      };
    }

    logger.info(
      `Mod analysis complete: ${metadata.id} v${metadata.version} (${loaderInfo.loader})`,
    );
    return result;
  }

  /** Read and parse `META-INF/MANIFEST.MF` (empty manifest when absent). */
  private readManifest(zip: AdmZip): JarManifest {
    const entry = zip.getEntry('META-INF/MANIFEST.MF');
    if (!entry) return { main: new Map(), sections: [] };
    try {
      return parseJarManifest(entry.getData().toString('utf8'));
    } catch (e) {
      logger.warn('Failed to parse MANIFEST.MF', e);
      return { main: new Map(), sections: [] };
    }
  }

  /**
   * Detect which mod loader the JAR is for, keeping the parsed metadata so it
   * does not have to be read twice.
   */
  private detectModLoader(zip: AdmZip): {
    loader: ModLoader;
    fabricModJson?: FabricModJson;
    quiltModJson?: QuiltModJson;
    mcmodInfo?: unknown;
    modsToml?: unknown;
  } {
    // Check for Fabric (fabric.mod.json)
    const fabricEntry = zip.getEntry('fabric.mod.json');
    if (fabricEntry) {
      try {
        const content = fabricEntry.getData().toString('utf8');
        const fabricModJson = JSON.parse(content) as FabricModJson;
        return { loader: 'fabric', fabricModJson };
      } catch (e) {
        logger.warn('Failed to parse fabric.mod.json', e);
      }
    }

    // Check for Quilt (quilt.mod.json)
    const quiltEntry = zip.getEntry('quilt.mod.json');
    if (quiltEntry) {
      try {
        const content = quiltEntry.getData().toString('utf8');
        const quiltModJson = JSON.parse(content) as QuiltModJson;
        return { loader: 'quilt', quiltModJson };
      } catch (e) {
        logger.warn('Failed to parse quilt.mod.json', e);
      }
    }

    // NeoForge 1.20.5+ renamed mods.toml.
    const neoforgeEntry = zip.getEntry('META-INF/neoforge.mods.toml');
    if (neoforgeEntry) {
      return { loader: 'neoforge', modsToml: neoforgeEntry.getData().toString('utf8') };
    }

    // Forge 1.13 - 1.20.x.
    const forgeEntry = zip.getEntry('META-INF/mods.toml');
    if (forgeEntry) {
      return { loader: 'forge', modsToml: forgeEntry.getData().toString('utf8') };
    }

    // Legacy Forge (1.6.4 - 1.12.2): mcmod.info, or the FML annotation cache
    // written by a coremod.
    const mcmodEntry = zip.getEntry('mcmod.info');
    if (mcmodEntry) {
      return { loader: 'forge', mcmodInfo: mcmodEntry.getData().toString('utf8') };
    }
    if (zip.getEntry('META-INF/fml_cache_annotation.json')) {
      return { loader: 'forge' };
    }

    // A jar with an FML coremod/tweaker manifest but no metadata file is still
    // a Forge artifact (common for coremod libraries and `-dev` jars).
    const manifestEntry = zip.getEntry('META-INF/MANIFEST.MF');
    if (manifestEntry) {
      try {
        const manifest = parseJarManifest(manifestEntry.getData().toString('utf8'));
        if (
          getManifestAttribute(manifest.main, 'FMLCorePlugin') ||
          getManifestAttribute(manifest.main, 'TweakClass') ||
          getManifestAttribute(manifest.main, 'FMLCorePluginContainsFMLMod')
        ) {
          return { loader: 'forge' };
        }
      } catch {
        // fall through to unknown
      }
    }

    return { loader: 'unknown' };
  }

  /**
   * Parse mod metadata based on loader type
   */
  private parseMetadata(zip: AdmZip, loader: ModLoader, manifest: JarManifest): ParsedModMetadata {
    switch (loader) {
      case 'fabric':
        return this.parseFabricMetadata(zip);
      case 'quilt':
        return this.parseQuiltMetadata(zip);
      case 'forge':
      case 'neoforge':
        return this.parseForgeMetadata(zip, loader, manifest);
      default:
        return this.createUnknownMetadata(manifest);
    }
  }

  /**
   * Parse Fabric mod metadata
   */
  private parseFabricMetadata(zip: AdmZip): ParsedModMetadata {
    const entry = zip.getEntry('fabric.mod.json');
    if (!entry) {
      throw new Error('fabric.mod.json not found');
    }

    const content = entry.getData().toString('utf8');
    const mod = JSON.parse(content) as FabricModJson;

    // Parse authors
    const authors: ModPerson[] = (mod.authors ?? []).map((a) =>
      typeof a === 'string' ? { name: a } : { name: a.name, contact: a.contact as ModContact },
    );

    // Parse contributors
    const contributors: ModPerson[] = (mod.contributors ?? []).map((c) =>
      typeof c === 'string' ? { name: c } : { name: c.name, contact: c.contact as ModContact },
    );

    // Parse dependencies
    const dependencies: ModDependency[] = [];
    this.addFabricDependencies(dependencies, mod.depends, 'required');
    this.addFabricDependencies(dependencies, mod.recommends, 'optional');
    this.addFabricDependencies(dependencies, mod.suggests, 'suggests');
    this.addFabricDependencies(dependencies, mod.breaks, 'breaks');
    this.addFabricDependencies(dependencies, mod.conflicts, 'incompatible');

    // Parse entrypoints
    const entrypoints: ModEntrypoint[] = [];
    const entrypointClasses: string[] = [];
    if (mod.entrypoints) {
      for (const [type, eps] of Object.entries(mod.entrypoints)) {
        for (const ep of eps) {
          if (typeof ep === 'string') {
            entrypoints.push({ type, value: ep });
            entrypointClasses.push(this.extractClassName(ep));
          } else {
            entrypoints.push({ type, value: ep.value, adapter: ep.adapter });
            entrypointClasses.push(this.extractClassName(ep.value));
          }
        }
      }
    }

    // Parse mixin configs
    const mixinConfigFiles: string[] = [];
    if (mod.mixins) {
      for (const mixin of mod.mixins) {
        if (typeof mixin === 'string') {
          mixinConfigFiles.push(mixin);
        } else {
          mixinConfigFiles.push(mixin.config);
        }
      }
    }

    // Get Minecraft version from depends
    let minecraft = '*';
    const mcDep = dependencies.find((d) => d.modId === 'minecraft');
    if (mcDep) {
      minecraft = mcDep.versionRange;
    }

    // Get loader version from depends
    let loaderVersion: string | undefined;
    const loaderDep = dependencies.find((d) => d.modId === 'fabricloader');
    if (loaderDep) {
      loaderVersion = loaderDep.versionRange;
    }

    // Get java version from depends
    let javaVersion: number | undefined;
    const javaDep = dependencies.find((d) => d.modId === 'java');
    if (javaDep) {
      const match = javaDep.versionRange.match(/>=?(\d+)/);
      if (match) {
        javaVersion = Number.parseInt(match[1], 10);
      }
    }

    // Nested JARs
    const nestedJars = mod.jars?.map((j) => j.file);

    return {
      id: mod.id,
      version: mod.version,
      name: mod.name,
      description: mod.description,
      authors,
      contributors: contributors.length > 0 ? contributors : undefined,
      license: mod.license,
      icon: mod.icon,
      contact: mod.contact as ModContact,
      minecraft,
      loaderVersion,
      javaVersion,
      environment: (mod.environment ?? '*') as ModEnvironment,
      dependencies,
      entrypoints,
      mixinConfigFiles,
      accessWidener: mod.accessWidener,
      accessTransformers: [],
      nestedJars,
      entrypointClasses,
      warnings: [],
    };
  }

  /**
   * Parse Quilt mod metadata
   */
  private parseQuiltMetadata(zip: AdmZip): ParsedModMetadata {
    const entry = zip.getEntry('quilt.mod.json');
    if (!entry) {
      throw new Error('quilt.mod.json not found');
    }

    const content = entry.getData().toString('utf8');
    const mod = JSON.parse(content) as QuiltModJson;
    const loader = mod.quilt_loader;
    const meta = loader.metadata ?? {};

    // Parse contributors
    const authors: ModPerson[] = [];
    if (meta.contributors) {
      for (const [name, role] of Object.entries(meta.contributors)) {
        authors.push({ name, contact: { homepage: role } });
      }
    }

    // Parse dependencies
    const dependencies: ModDependency[] = [];
    if (loader.depends) {
      for (const dep of loader.depends) {
        const versionRange = Array.isArray(dep.versions)
          ? dep.versions.join(' || ')
          : (dep.versions ?? '*');
        dependencies.push({
          modId: dep.id,
          versionRange,
          type: dep.optional ? 'optional' : 'required',
          mandatory: !dep.optional,
        });
      }
    }
    if (loader.breaks) {
      for (const dep of loader.breaks) {
        const versionRange = Array.isArray(dep.versions)
          ? dep.versions.join(' || ')
          : (dep.versions ?? '*');
        dependencies.push({
          modId: dep.id,
          versionRange,
          type: 'breaks',
          mandatory: false,
        });
      }
    }

    // Parse entrypoints
    const entrypoints: ModEntrypoint[] = [];
    const entrypointClasses: string[] = [];
    if (loader.entrypoints) {
      for (const [type, eps] of Object.entries(loader.entrypoints)) {
        for (const ep of eps) {
          if (typeof ep === 'string') {
            entrypoints.push({ type, value: ep });
            entrypointClasses.push(this.extractClassName(ep));
          } else {
            entrypoints.push({ type, value: ep.value, adapter: ep.adapter });
            entrypointClasses.push(this.extractClassName(ep.value));
          }
        }
      }
    }

    // Parse mixin configs
    const mixinConfigFiles: string[] = [];
    if (mod.mixin) {
      if (typeof mod.mixin === 'string') {
        mixinConfigFiles.push(mod.mixin);
      } else {
        mixinConfigFiles.push(...mod.mixin);
      }
    }

    // Get Minecraft version
    let minecraft = '*';
    const mcDep = dependencies.find((d) => d.modId === 'minecraft');
    if (mcDep) {
      minecraft = mcDep.versionRange;
    }

    // Get loader version
    let loaderVersion: string | undefined;
    const loaderDep = dependencies.find((d) => d.modId === 'quilt_loader');
    if (loaderDep) {
      loaderVersion = loaderDep.versionRange;
    }

    // Environment mapping
    let environment: ModEnvironment = '*';
    if (mod.minecraft?.environment === 'client') {
      environment = 'client';
    } else if (mod.minecraft?.environment === 'dedicated_server') {
      environment = 'server';
    }

    return {
      id: loader.id,
      version: loader.version,
      name: meta.name,
      description: meta.description,
      authors,
      license: meta.license,
      icon: meta.icon,
      contact: meta.contact as ModContact,
      minecraft,
      loaderVersion,
      javaVersion: undefined,
      environment,
      dependencies,
      entrypoints,
      mixinConfigFiles,
      accessWidener: mod.access_widener,
      accessTransformers: [],
      nestedJars: loader.jars,
      entrypointClasses,
      warnings: [],
    };
  }

  /**
   * Parse Forge/NeoForge mod metadata.
   *
   * Two formats, chosen by what the JAR actually contains rather than by a
   * version guess:
   * - `META-INF/mods.toml` / `META-INF/neoforge.mods.toml` for Forge 1.13+ and
   *   NeoForge, and
   * - root `mcmod.info` for Forge 1.6.4 – 1.12.2.
   *
   * The manifest is consulted for facts neither TOML nor JSON carries:
   * `FMLCorePlugin` / `TweakClass` / `Main-Class` entry points, `FMLAT` access
   * transformers and `MixinConfigs`.
   */
  private parseForgeMetadata(
    zip: AdmZip,
    loader: 'forge' | 'neoforge',
    manifest: JarManifest,
  ): ParsedModMetadata {
    const warnings: string[] = [];
    const tomlPath = loader === 'neoforge' ? 'META-INF/neoforge.mods.toml' : 'META-INF/mods.toml';

    const entrypoints: ModEntrypoint[] = [];
    const entrypointClasses: string[] = [];
    const accessTransformers = splitManifestList(getManifestAttribute(manifest.main, 'FMLAT'));

    // --- Modern format: mods.toml ---
    const tomlEntry = zip.getEntry(tomlPath);
    if (tomlEntry) {
      const toml = parseModsToml(tomlEntry.getData().toString('utf8'));

      if (toml.mods.length === 0) {
        warnings.push(`${tomlPath} contains no [[mods]] entry`);
      } else if (toml.mods.length > 1) {
        warnings.push(
          `${tomlPath} declares ${toml.mods.length} mods; reported metadata is for '${toml.mods[0].modId}' (others: ${toml.mods
            .slice(1)
            .map((m) => m.modId)
            .join(', ')})`,
        );
      }

      const primary = toml.mods[0];
      const dependencies: ModDependency[] = [];
      for (const dep of toml.dependencies) {
        dependencies.push({
          modId: dep.modId,
          versionRange: dep.versionRange ?? '*',
          type: this.forgeDependencyType(dep.mandatory, dep.type),
          mandatory: dep.mandatory && dep.type !== 'incompatible' && dep.type !== 'discouraged',
          side: dep.side,
        });
      }

      const minecraftDep = dependencies.find((d) => d.modId === 'minecraft');
      const loaderName = loader === 'neoforge' ? 'neoforge' : 'forge';
      const loaderDep = dependencies.find((d) => d.modId === loaderName || d.modId === 'forge');

      // `loaderVersion` is the FORGE version range (`[36,)`), not a Java
      // requirement — falling back to it reported "javaVersion: 36".
      const javaVersion = this.parseJavaVersion(primary?.javaVersion);

      const rawId = primary?.modId;
      const rawVersion = primary?.version;
      if (isUnresolvedPlaceholder(rawId) || isUnresolvedPlaceholder(rawVersion)) {
        warnings.push(
          `${tomlPath} still contains unresolved build placeholders (e.g. ${rawId ?? rawVersion}) — this looks like a pre-\`processResources\` sources/dev JAR. Pass modId/modVersion explicitly when decompiling it.`,
        );
      }

      return {
        id: rawId ?? UNKNOWN_MOD_ID,
        version: rawVersion ?? UNKNOWN_MOD_VERSION,
        name: primary?.displayName,
        description: primary?.description,
        authors: this.parseAuthorString(primary?.authors),
        license: toml.license,
        contact: toml.issueTrackerURL ? { issues: toml.issueTrackerURL } : undefined,
        icon: primary?.logoFile,
        minecraft: minecraftDep?.versionRange ?? '*',
        loaderVersion: loaderDep?.versionRange ?? toml.loaderVersion,
        javaVersion,
        environment: '*',
        dependencies,
        entrypoints,
        mixinConfigFiles: toml.mixinConfigs,
        accessTransformers: [...accessTransformers, ...toml.accessTransformerFiles],
        entrypointClasses,
        warnings,
      };
    }

    // --- Legacy format: mcmod.info (Forge 1.6.4 - 1.12.2) ---
    const mcmodEntry = zip.getEntry('mcmod.info');
    if (mcmodEntry) {
      const mods = parseMcmodInfo(mcmodEntry.getData().toString('utf8'));
      if (mods.length === 0) {
        warnings.push('mcmod.info could not be parsed (expected a JSON array of mod entries)');
      } else if (mods.length > 1) {
        warnings.push(
          `mcmod.info declares ${mods.length} mods; reported metadata is for '${mods[0].modId}' (others: ${mods
            .slice(1)
            .map((m) => m.modId)
            .join(', ')})`,
        );
      }

      const primary = mods[0];
      const deps: ModDependency[] = [];
      if (primary) {
        const mandatory = primary.useDependencyInformation;
        const requiredIds = new Set<string>();
        for (const modId of primary.requiredMods) {
          deps.push({ modId, versionRange: '*', type: 'required', mandatory });
          requiredIds.add(modId);
        }
        // `dependencies`/`dependants` are load-ORDER constraints, not
        // requirements, so they are reported as such rather than as hard deps.
        // A mod listed in BOTH `requiredMods` and `dependencies` (very common)
        // is already covered by the stronger entry and is not repeated.
        for (const modId of primary.dependencies) {
          if (requiredIds.has(modId)) continue;
          deps.push({ modId, versionRange: '*', type: 'ordering', mandatory: false });
        }
        for (const modId of primary.dependants) {
          if (requiredIds.has(modId)) continue;
          deps.push({ modId, versionRange: '*', type: 'ordering', mandatory: false });
        }
        if (primary.parent && !requiredIds.has(primary.parent)) {
          deps.push({
            modId: primary.parent,
            versionRange: '*',
            type: 'required',
            mandatory: true,
          });
        }

        // `mcversion` is the only Minecraft compatibility signal legacy Forge
        // metadata has; expose it as a dependency so it drives both
        // `compatibility.minecraft` and `remap_mod_jar`'s version auto-detection.
        const mcRange = primary.mcVersion ?? primary.acceptedMinecraftVersions;
        if (mcRange) {
          deps.unshift({
            modId: 'minecraft',
            versionRange: mcRange,
            type: 'required',
            mandatory: true,
          });
        } else {
          warnings.push(
            'mcmod.info declares no "mcversion"/"acceptedMinecraftVersions"; the target Minecraft version is unknown',
          );
        }
      }

      let environment: ModEnvironment = '*';
      const legacy = primary as unknown as {
        clientSideOnly?: boolean;
        serverSideOnly?: boolean;
      };
      if (legacy?.clientSideOnly) environment = 'client';
      else if (legacy?.serverSideOnly) environment = 'server';

      return {
        id: primary?.modId ?? UNKNOWN_MOD_ID,
        version: primary?.version ?? UNKNOWN_MOD_VERSION,
        name: primary?.name,
        description: primary?.description,
        authors: (primary?.authors ?? []).map((name) => ({ name })),
        license: undefined,
        contact: primary?.url ? { homepage: primary.url, issues: primary.updateUrl } : undefined,
        icon: primary?.logoFile,
        minecraft: primary?.mcVersion ?? primary?.acceptedMinecraftVersions ?? '*',
        loaderVersion: undefined,
        javaVersion: undefined,
        environment,
        dependencies: deps,
        entrypoints,
        mixinConfigFiles: [],
        accessTransformers,
        entrypointClasses,
        warnings,
      };
    }

    // --- No metadata file: manifest-only Forge artifact ---
    warnings.push(
      `No ${tomlPath} or mcmod.info found — mod id/version fall back to MANIFEST.MF and @Mod bytecode detection`,
    );
    return {
      id: UNKNOWN_MOD_ID,
      version: UNKNOWN_MOD_VERSION,
      authors: [],
      minecraft: '*',
      environment: '*',
      dependencies: [],
      entrypoints,
      mixinConfigFiles: [],
      accessTransformers,
      entrypointClasses,
      warnings,
    };
  }

  /** Map Forge `mandatory` / NeoForge `type` onto the shared dependency types. */
  private forgeDependencyType(mandatory: boolean, neoforgeType?: string): DependencyType {
    switch (neoforgeType) {
      case 'incompatible':
        return 'incompatible';
      case 'discouraged':
        return 'suggests';
      case 'optional':
        return 'optional';
      default:
        return mandatory ? 'required' : 'optional';
    }
  }

  /** Parse `authors="a, b, c"` / `authors="a"` into person entries. */
  private parseAuthorString(authors: string | undefined): ModPerson[] {
    if (!authors) return [];
    return authors
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
  }

  /** Extract a Java major version from a Forge version range (`[17,)`). */
  private parseJavaVersion(range: string | undefined): number | undefined {
    if (!range) return undefined;
    const match = range.match(/(\d+)/);
    return match ? Number.parseInt(match[1], 10) : undefined;
  }

  /**
   * Metadata for a JAR whose loader could not be identified. The manifest still
   * often identifies it, so those attributes are used instead of nothing.
   */
  private createUnknownMetadata(manifest: JarManifest): ParsedModMetadata {
    const warnings = [
      'No recognized mod metadata (fabric.mod.json, quilt.mod.json, mods.toml, mcmod.info) — loader could not be determined',
    ];
    return {
      id: UNKNOWN_MOD_ID,
      version: UNKNOWN_MOD_VERSION,
      authors: [],
      minecraft: '*',
      environment: '*',
      dependencies: [],
      entrypoints: [],
      mixinConfigFiles: [],
      accessTransformers: splitManifestList(getManifestAttribute(manifest.main, 'FMLAT')),
      entrypointClasses: [],
      warnings,
    };
  }

  /**
   * Add Fabric-style dependencies
   */
  private addFabricDependencies(
    deps: ModDependency[],
    source: Record<string, string | string[]> | undefined,
    type: DependencyType,
  ): void {
    if (!source) return;

    for (const [modId, versions] of Object.entries(source)) {
      const versionRange = Array.isArray(versions) ? versions.join(' || ') : versions;
      deps.push({
        modId,
        versionRange,
        type,
        mandatory: type === 'required',
      });
    }
  }

  /**
   * Extract class name from entrypoint value
   */
  private extractClassName(value: string): string {
    // Handle method references like "com.example.Mod::init"
    const methodSep = value.indexOf('::');
    if (methodSep !== -1) {
      return value.substring(0, methodSep);
    }
    return value;
  }

  /**
   * Union every source of mixin config names, in decreasing order of authority:
   * loader metadata, the manifest's `MixinConfigs`, then a filename scan.
   *
   * The scan is last and deliberately loose because legacy mods name configs
   * anything; the manifest is what makes `mixins.betterf1.json` (1.12.2 via
   * MixinBooter) discoverable at all.
   */
  private collectMixinConfigs(zip: AdmZip, declared: string[], manifest: JarManifest): string[] {
    const configs: string[] = [];
    const add = (name: string | undefined): void => {
      const trimmed = name?.trim();
      if (trimmed && !configs.includes(trimmed)) configs.push(trimmed);
    };

    for (const name of declared) add(name);
    for (const name of splitManifestList(getManifestAttribute(manifest.main, 'MixinConfigs'))) {
      add(name);
    }

    // Filename scan: any `*.mixins.json` anywhere in the JAR, excluding refmaps.
    for (const entry of zip.getEntries()) {
      const name = entry.entryName;
      if (!name.endsWith('.mixins.json')) continue;
      if (name.endsWith('-refmap.json')) continue;
      add(name);
    }

    return configs;
  }

  /**
   * Union access transformer sources: the manifest's `FMLAT` (1.7.10–1.16),
   * NeoForge's `[[accessTransformers]]` blocks, and the legacy filename
   * conventions (`<modid>_at.cfg`, `accesstransformer.cfg`).
   */
  private collectAccessTransformers(
    zip: AdmZip,
    declared: string[],
    manifest: JarManifest,
  ): string[] {
    const found: string[] = [];
    const basenames = new Set<string>();
    const add = (name: string | undefined): void => {
      const trimmed = name?.trim();
      if (!trimmed) return;
      // Some legacy mods ship the same AT twice (JAR root and META-INF/). They
      // are byte-identical, so validating both is pure noise — keep the first,
      // which is the manifest-declared or root copy.
      const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
      if (basenames.has(base)) return;
      basenames.add(base);
      found.push(trimmed);
    };

    for (const name of declared) add(name);
    for (const name of splitManifestList(getManifestAttribute(manifest.main, 'FMLAT'))) add(name);

    for (const entry of zip.getEntries()) {
      const name = entry.entryName;
      // Only the JAR root and META-INF carry mod ATs; anything deeper is a
      // shaded dependency's own file.
      const depth = name.split('/').length;
      const inAtRoot = depth === 1 || (depth === 2 && name.startsWith('META-INF/'));
      if (!inAtRoot) continue;
      const base = name.slice(name.lastIndexOf('/') + 1);
      if (base.endsWith('_at.cfg') || base === 'accesstransformer.cfg') add(name);
    }

    return found;
  }

  /**
   * Fold bytecode-derived facts back into the parsed metadata: `@Mod` ids,
   * `@Mod`/coremod entry points, and a consistency check when the annotation
   * disagrees with the metadata file.
   */
  private applyBytecodeFindings(
    metadata: ParsedModMetadata,
    classAnalysis: {
      modAnnotations: Array<{ className: string; modId?: string; isCoremod: boolean }>;
      entrypointClasses: string[];
    },
  ): void {
    const annotedIds = new Set<string>();
    for (const found of classAnalysis.modAnnotations) {
      const type = found.isCoremod ? 'coremod' : 'mod';
      this.addEntrypoint(metadata, { type, value: found.className });
      if (found.modId) annotedIds.add(found.modId);
    }

    for (const className of classAnalysis.entrypointClasses) {
      if (!metadata.entrypointClasses.includes(className)) {
        metadata.entrypointClasses.push(className);
      }
    }

    if (!isDetectedModId(metadata.id) && annotedIds.size > 0) {
      const [first] = [...annotedIds];
      metadata.id = first ?? UNKNOWN_MOD_ID;
      if (annotedIds.size > 1) {
        metadata.warnings.push(
          `@Mod annotations declare multiple ids (${[...annotedIds].join(', ')}); using '${metadata.id}'`,
        );
      } else {
        metadata.warnings.push(`Mod id recovered from the @Mod annotation: '${metadata.id}'`);
      }
    } else if (
      isDetectedModId(metadata.id) &&
      annotedIds.size > 0 &&
      !annotedIds.has(metadata.id)
    ) {
      metadata.warnings.push(
        `Mod metadata declares id '${metadata.id}' but @Mod annotations declare ${[...annotedIds]
          .map((id) => `'${id}'`)
          .join(', ')}`,
      );
    }
  }

  /** Append an entry point unless the same (type, value) pair is present. */
  private addEntrypoint(metadata: ParsedModMetadata, entrypoint: ModEntrypoint): void {
    const duplicate = metadata.entrypoints.some(
      (existing) => existing.type === entrypoint.type && existing.value === entrypoint.value,
    );
    if (duplicate) return;
    metadata.entrypoints.push(entrypoint);
    if (!metadata.entrypointClasses.includes(entrypoint.value)) {
      metadata.entrypointClasses.push(entrypoint.value);
    }
  }

  /**
   * Last-resort id/version from the manifest. Gradle `-dev` jars and coremod
   * libraries routinely ship no metadata file at all but do set
   * `Implementation-Version`.
   */
  private applyManifestFallbacks(metadata: ParsedModMetadata, manifest: JarManifest): void {
    if (!isDetectedModVersion(metadata.version)) {
      const version = getManifestAttribute(manifest.main, 'Implementation-Version');
      if (version && version.toUpperCase() !== 'UNKNOWN') {
        metadata.version = version;
        metadata.warnings.push(`Mod version recovered from MANIFEST.MF: '${version}'`);
      }
    }

    // Manifest-declared entry points. These are the only entry-point signal
    // legacy coremods and tweakers have.
    const corePlugin = getManifestAttribute(manifest.main, 'FMLCorePlugin');
    if (corePlugin) {
      this.addEntrypoint(metadata, { type: 'coremod', value: corePlugin });
    }
    const tweakClass = getManifestAttribute(manifest.main, 'TweakClass');
    if (tweakClass) {
      this.addEntrypoint(metadata, { type: 'tweaker', value: tweakClass });
    }
    const mainClass = getManifestAttribute(manifest.main, 'Main-Class');
    if (mainClass) {
      this.addEntrypoint(metadata, { type: 'main', value: mainClass });
    }

    if (!isDetectedModId(metadata.id)) {
      const title = getManifestAttribute(manifest.main, 'Implementation-Title');
      if (title) {
        metadata.warnings.push(
          `Mod id could not be determined; MANIFEST.MF Implementation-Title is '${title}'`,
        );
      }
    }
  }

  /**
   * Parse mixin configuration files
   */
  private parseMixinConfigs(zip: AdmZip, configFiles: string[]): ModMixinConfig[] {
    const configs: ModMixinConfig[] = [];

    for (const configFile of configFiles) {
      const entry = zip.getEntry(configFile);
      if (!entry) {
        logger.warn(`Mixin config not found: ${configFile}`);
        continue;
      }

      try {
        const content = entry.getData().toString('utf8');
        const config = JSON.parse(content) as MixinConfigJson;

        configs.push({
          configFile,
          package: config.package,
          mixins: config.mixins,
          clientMixins: config.client,
          serverMixins: config.server,
          required: config.required,
          refmap: config.refmap,
          compatibilityLevel: config.compatibilityLevel,
          minVersion: config.minVersion,
        });
      } catch (e) {
        logger.warn(`Failed to parse mixin config: ${configFile}`, e);
      }
    }

    return configs;
  }

  /**
   * Get raw mixin config JSON
   */
  private getRawMixinConfigs(zip: AdmZip, configFiles: string[]): Record<string, unknown> {
    const configs: Record<string, unknown> = {};

    for (const configFile of configFiles) {
      const entry = zip.getEntry(configFile);
      if (!entry) continue;

      try {
        const content = entry.getData().toString('utf8');
        configs[configFile] = JSON.parse(content);
      } catch {
        // Skip invalid configs
      }
    }

    return configs;
  }

  /**
   * Analyze classes in the JAR
   */
  private async analyzeClasses(
    _zip: AdmZip,
    entries: AdmZip.IZipEntry[],
    entrypointClasses: string[],
    mixinConfigs: ModMixinConfig[],
    options: ModAnalyzerOptions,
  ): Promise<{
    total: number;
    packages: Record<string, number>;
    mixinClasses: ModClass[];
    entrypointClasses: string[];
    allClasses?: ModClass[];
    modAnnotations: Array<{ className: string; modId?: string; isCoremod: boolean }>;
  }> {
    const packages: Record<string, number> = {};
    const mixinClasses: ModClass[] = [];
    const allClasses: ModClass[] = [];
    const modAnnotations: Array<{ className: string; modId?: string; isCoremod: boolean }> = [];

    // Get all mixin class names from configs
    const mixinClassNames = new Set<string>();
    for (const config of mixinConfigs) {
      const pkg = config.package ?? '';
      for (const mixin of config.mixins ?? []) {
        mixinClassNames.add(pkg ? `${pkg}.${mixin}` : mixin);
      }
      for (const mixin of config.clientMixins ?? []) {
        mixinClassNames.add(pkg ? `${pkg}.${mixin}` : mixin);
      }
      for (const mixin of config.serverMixins ?? []) {
        mixinClassNames.add(pkg ? `${pkg}.${mixin}` : mixin);
      }
    }

    let total = 0;

    for (const entry of entries) {
      if (!entry.entryName.endsWith('.class')) continue;
      if (entry.entryName.startsWith('META-INF/')) continue;

      total++;

      // Convert path to class name
      const className = entry.entryName.replace(/\//g, '.').replace(/\.class$/, '');

      // Get package
      const lastDot = className.lastIndexOf('.');
      const pkg = lastDot > 0 ? className.substring(0, lastDot) : '(default)';
      packages[pkg] = (packages[pkg] ?? 0) + 1;

      // Check if this is a known mixin class
      const isMixin = mixinClassNames.has(className);

      // Basic class info
      const classInfo: ModClass = {
        className,
        isMixin,
        isInterface: false,
        isAbstract: false,
        isEnum: false,
        interfaces: [],
        access: [],
        methodCount: 0,
        fieldCount: 0,
      };

      // Analyze bytecode for detailed info
      if (options.analyzeBytecode !== false) {
        try {
          const data = entry.getData();
          const info = parseClassFile(data);
          if (info) {
            const modId = extractModAnnotationId(info);
            const isCoremod = isCoremodClass(info);
            // Only a real declaration counts as an entry point. A mixin class
            // is NOT a mod entry point — the earlier `isMixin ||` here turned
            // every one of Meteor's 200+ mixins into a bogus `@Mod` entry.
            if (hasModAnnotation(info) || isCoremod) {
              modAnnotations.push({ className, modId, isCoremod });
            }
            const mixinTargets = extractMixinTargets(info);
            Object.assign(classInfo, {
              isMixin: isMixin || mixinTargets.length > 0,
              isInterface: info.isInterface,
              isAbstract: info.isAbstract,
              isEnum: info.isEnum,
              superclass: info.superName,
              interfaces: info.interfaces,
              access: accessFlagNames(info.accessFlags),
              methodCount: info.methodCount,
              fieldCount: info.fieldCount,
              mixinTargets: mixinTargets.length > 0 ? mixinTargets : undefined,
            });
          }
        } catch (e) {
          // Skip classes that can't be analyzed
          logger.debug(`Failed to analyze bytecode for ${className}: ${e}`);
        }
      }

      if (isMixin || classInfo.isMixin) {
        mixinClasses.push(classInfo);
      }

      if (options.includeAllClasses) {
        allClasses.push(classInfo);
      }
    }

    // The @Mod/coremod rows are collected separately; a class can be both a
    // coremod and a mixin, so it stays in the mixin list on its own merit.
    return {
      total,
      packages,
      mixinClasses,
      entrypointClasses,
      allClasses: options.includeAllClasses ? allClasses : undefined,
      modAnnotations,
    };
  }
}

// Singleton instance
let instance: ModAnalyzerService | null = null;

export function getModAnalyzerService(): ModAnalyzerService {
  if (!instance) {
    instance = new ModAnalyzerService();
  }
  return instance;
}
