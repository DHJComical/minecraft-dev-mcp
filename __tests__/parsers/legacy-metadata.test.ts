import { describe, expect, it } from 'vitest';
import {
  getManifestAttribute,
  parseJarManifest,
  splitManifestList,
} from '../../src/parsers/jar-manifest.js';
import { parseMcmodInfo } from '../../src/parsers/mcmod-info.js';
import { parseModsToml, parseToml } from '../../src/parsers/mods-toml.js';

/**
 * Legacy/loader metadata parser tests.
 *
 * These cover the formats that the mod analyzer previously could not read at
 * all: `mcmod.info` (Forge 1.6.4-1.12.2) and the dependency blocks of
 * `mods.toml`. No JAR, no Java, no network — the parsers are pure functions.
 */

describe('parseMcmodInfo (legacy Forge, 1.6.4-1.12.2)', () => {
  it('reads a bare JSON array of mod entries', () => {
    const [mod] = parseMcmodInfo(
      JSON.stringify([
        {
          modid: 'storagedrawers',
          name: 'Storage Drawers',
          version: '1.12.2-5.4.2',
          description: 'Multi-drawer storage blocks.',
          authorList: ['jaquadro'],
          url: 'http://www.jaquadro.com/',
          logoFile: 'assets/storagedrawers/textures/logo.png',
          requiredMods: ['forge', 'chameleon'],
          dependencies: ['chameleon'],
          useDependencyInformation: true,
        },
      ]),
    );

    expect(mod?.modId).toBe('storagedrawers');
    expect(mod?.version).toBe('1.12.2-5.4.2');
    expect(mod?.name).toBe('Storage Drawers');
    expect(mod?.authors).toEqual(['jaquadro']);
    expect(mod?.requiredMods).toEqual(['forge', 'chameleon']);
    expect(mod?.dependencies).toEqual(['chameleon']);
    expect(mod?.useDependencyInformation).toBe(true);
  });

  it('reads the `modList` object shape', () => {
    const mods = parseMcmodInfo(JSON.stringify({ modList: [{ modid: 'a', version: '1' }] }));
    expect(mods.map((m) => m.modId)).toEqual(['a']);
  });

  it('splits several author names packed into one array element', () => {
    // Extremely common in the wild: `"authorList": ["A, B, C"]`.
    const [mod] = parseMcmodInfo(
      JSON.stringify([
        { modid: 'betterf1', authorList: ['UltimateBoomer,  MovTery,  DHJComical'] },
      ]),
    );
    expect(mod?.authors).toEqual(['UltimateBoomer', 'MovTery', 'DHJComical']);
  });

  it('reads mcversion and acceptedMinecraftVersions', () => {
    const [withMc] = parseMcmodInfo(JSON.stringify([{ modid: 'a', mcversion: '1.7.10' }]));
    expect(withMc?.mcVersion).toBe('1.7.10');

    const [withRange] = parseMcmodInfo(
      JSON.stringify([{ modid: 'b', acceptedMinecraftVersions: '[1.7.10,1.8)' }]),
    );
    expect(withRange?.acceptedMinecraftVersions).toBe('[1.7.10,1.8)');
  });

  it('tolerates trailing commas', () => {
    const mods = parseMcmodInfo('[{ "modid": "a", "version": "1", }]');
    expect(mods[0]?.modId).toBe('a');
  });

  it('returns an empty list for unparseable content instead of throwing', () => {
    expect(parseMcmodInfo('not json at all')).toEqual([]);
    expect(parseMcmodInfo('[]')).toEqual([]);
  });

  it('skips entries without a modid', () => {
    expect(parseMcmodInfo(JSON.stringify([{ name: 'no id' }, { modid: 'ok' }]))).toHaveLength(1);
  });
});

describe('parseJarManifest', () => {
  it('parses main attributes case-insensitively', () => {
    const manifest = parseJarManifest('Manifest-Version: 1.0\nMixinConfigs: a.json, b.json\n');
    expect(getManifestAttribute(manifest.main, 'MixinConfigs')).toBe('a.json, b.json');
    expect(getManifestAttribute(manifest.main, 'mixinconfigs')).toBe('a.json, b.json');
  });

  it('unfolds continuation lines, joining without a space', () => {
    // JAR manifests wrap at 72 bytes; the break and the leading space vanish.
    const manifest = parseJarManifest('FMLAT: legacymod_at.cfg,\n other_at.cfg\n');
    expect(getManifestAttribute(manifest.main, 'FMLAT')).toBe('legacymod_at.cfg,other_at.cfg');
  });

  it('handles CRLF lines', () => {
    const manifest = parseJarManifest(
      'Manifest-Version: 1.0\r\nTweakClass: com.example.Tweaker\r\n',
    );
    expect(getManifestAttribute(manifest.main, 'TweakClass')).toBe('com.example.Tweaker');
  });

  it('separates named entry sections from the main attributes', () => {
    const manifest = parseJarManifest(
      'Manifest-Version: 1.0\n\nName: com/example/A.class\nSHA-256: abc\n',
    );
    expect(getManifestAttribute(manifest.main, 'SHA-256')).toBeUndefined();
    expect(manifest.sections).toHaveLength(1);
    expect(getManifestAttribute(manifest.sections[0] as Map<string, string>, 'SHA-256')).toBe(
      'abc',
    );
  });

  it('skips malformed lines rather than failing the whole manifest', () => {
    const manifest = parseJarManifest('garbage line\nMixinConfigs: a.json\n');
    expect(getManifestAttribute(manifest.main, 'MixinConfigs')).toBe('a.json');
  });

  it('splits comma- and space-separated file lists', () => {
    expect(splitManifestList('a.json, b.json')).toEqual(['a.json', 'b.json']);
    expect(splitManifestList('a_at.cfg b_at.cfg')).toEqual(['a_at.cfg', 'b_at.cfg']);
    expect(splitManifestList(undefined)).toEqual([]);
  });
});

describe('parseToml / parseModsToml', () => {
  it('parses scalars, tables and array-of-tables', () => {
    const root = parseToml(`
      modLoader="javafml"
      loaderVersion="[36,)"

      [[mods]]
      modId="example"
      version="2.0.0"

      [[dependencies.example]]
      modId="minecraft"
      versionRange="[1.16.5,1.17)"
    `);

    expect(root.modLoader).toBe('javafml');
    expect(Array.isArray(root.mods)).toBe(true);
    const mods = root.mods as Array<Record<string, unknown>>;
    expect(mods[0]?.modId).toBe('example');
  });

  it('reads triple-quoted multi-line descriptions', () => {
    const toml = parseModsToml(`
[[mods]]
modId="example"
description='''
Line one.
Line two.
'''
`);
    // TOML strips the newline that follows the opening delimiter; the metadata
    // reader then trims the value like every other string field.
    expect(toml.mods[0]?.description).toBe('Line one.\nLine two.');
  });

  it('reads double-quoted multi-line descriptions with escapes', () => {
    const toml = parseModsToml(`
[[mods]]
modId="example"
description="""
Tab\\there.
"""
`);
    expect(toml.mods[0]?.description).toBe('Tab\there.');
  });

  it('keeps dependency blocks separate — the bug a flat regex caused', () => {
    // Two dependency blocks for DIFFERENT mods. A file-wide regex matched the
    // first block's `modId` and a later block's `versionRange` across the
    // boundary, which is why the Minecraft version came out as `*`.
    const toml = parseModsToml(`
[[mods]]
modId="example"

[[dependencies.example]]
modId="forge"
mandatory=true
versionRange="[36,)"
ordering="NONE"
side="BOTH"

[[dependencies.example]]
modId="minecraft"
mandatory=true
versionRange="[1.16.5,1.17)"
ordering="NONE"
side="BOTH"
`);

    expect(toml.dependencies).toHaveLength(2);
    const mc = toml.dependencies.find((dep) => dep.modId === 'minecraft');
    // The previous regex required a `]` before the closing quote, so this very
    // ordinary half-open range never matched at all.
    expect(mc?.versionRange).toBe('[1.16.5,1.17)');
    expect(mc?.side).toBe('BOTH');
    expect(mc?.mandatory).toBe(true);
  });

  it('understands NeoForge `type` instead of `mandatory`', () => {
    const toml = parseModsToml(`
[[mods]]
modId="example"

[[dependencies.example]]
modId="neoforge"
type="required"
versionRange="[21,)"

[[dependencies.example]]
modId="other"
type="optional"
versionRange="[1,)"

[[dependencies.example]]
modId="rival"
type="incompatible"
`);
    const byModId = new Map(toml.dependencies.map((dep) => [dep.modId, dep]));
    expect(byModId.get('neoforge')?.mandatory).toBe(true);
    expect(byModId.get('other')?.mandatory).toBe(false);
    expect(byModId.get('rival')?.mandatory).toBe(false);
  });

  it('collects mixin configs and access transformer files', () => {
    const toml = parseModsToml(`
[[mods]]
modId="example"

[[mixins]]
config="example.mixins.json"

[[accessTransformers]]
file="META-INF/accesstransformer.cfg"
`);
    expect(toml.mixinConfigs).toEqual(['example.mixins.json']);
    expect(toml.accessTransformerFiles).toEqual(['META-INF/accesstransformer.cfg']);
  });

  it('ignores comments and blank lines', () => {
    const toml = parseModsToml(`
# leading comment
modLoader="javafml"   # trailing comment

[[mods]]
modId="example"  # another
`);
    expect(toml.modLoader).toBe('javafml');
    expect(toml.mods[0]?.modId).toBe('example');
  });

  it('strips a UTF-8 BOM', () => {
    const toml = parseModsToml('\uFEFFmodLoader="javafml"\n[[mods]]\nmodId="x"\n');
    expect(toml.modLoader).toBe('javafml');
  });

  it('returns empty collections for an unparseable file', () => {
    const toml = parseModsToml('not = [ a toml');
    expect(toml.mods).toEqual([]);
    expect(toml.dependencies).toEqual([]);
  });
});
