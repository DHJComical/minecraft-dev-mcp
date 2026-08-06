import { copyFileSync, existsSync as nodeExistsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  BytecodeClass,
  BytecodeField,
  BytecodeMethod,
} from '../../src/java/bytecode-dumper.js';
import { handleValidateAccessWidener } from '../../src/server/tools.js';
import {
  getAccessWidenerService,
  validateEntryAgainstBytecode,
} from '../../src/services/access-widener-service.js';
import type { AccessWidenerEntry } from '../../src/types/minecraft.js';
import { AccessWidenerParseError } from '../../src/utils/errors.js';
import { ensureDir } from '../../src/utils/file-utils.js';
import { getRemappedJarPath } from '../../src/utils/paths.js';
import { TEST_MAPPING, TEST_VERSION } from '../test-constants.js';

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

/**
 * Build an AccessWidenerEntry with sensible defaults for the regression tests
 * below. Validation exercises go through the `validateEntryAgainstBytecode` test
 * seam, driven by hand-built `BytecodeClass` fixtures — bytecode is the same
 * ground truth the production path reads from the remapped JAR.
 */
function makeEntry(
  partial: Partial<AccessWidenerEntry> & { className: string },
): AccessWidenerEntry {
  return {
    accessType: 'accessible',
    targetType: 'class',
    line: 1,
    ...partial,
  };
}

// --- Bytecode fixture builders (mirror the ASM dumper's JSON shape) ---------

function bcMethod(name: string, desc: string, flags: string[] = ['public']): BytecodeMethod {
  return { name, desc, access: 0, flags, signature: null, exceptions: [] };
}

function bcField(name: string, desc = 'I', flags: string[] = ['public']): BytecodeField {
  return { name, desc, access: 0, flags, signature: null, value: null };
}

function bcClass(partial: Partial<BytecodeClass> & { name: string }): BytecodeClass {
  return {
    access: 0,
    flags: ['public'],
    superName: 'java/lang/Object',
    interfaces: [],
    signature: null,
    isInterface: false,
    isEnum: false,
    isRecord: false,
    isAnnotation: false,
    isAbstract: false,
    isFinal: false,
    isSealed: false,
    nestHost: null,
    nestMembers: null,
    permittedSubclasses: null,
    recordComponents: null,
    canonicalConstructor: null,
    innerClasses: [],
    fields: [],
    methods: [],
    ...partial,
  };
}

function mapOf(...classes: BytecodeClass[]): Map<string, BytecodeClass> {
  return new Map(classes.map((c) => [c.name, c]));
}

/**
 * Access Widener Service Tests
 *
 * Tests the access widener service's ability to:
 * - Parse Access Widener files
 * - Validate entries against Minecraft bytecode
 * - Convert Java descriptors to readable format
 */

describe('Access Widener Service', () => {
  it('should parse a simple access widener', () => {
    const awService = getAccessWidenerService();

    const content = `
accessWidener v2 named

accessible class net/minecraft/entity/Entity
accessible method net/minecraft/entity/Entity tick ()V
accessible field net/minecraft/entity/Entity age I
mutable field net/minecraft/entity/Entity age I
`;

    const aw = awService.parseAccessWidener(content);

    expect(aw).toBeDefined();
    expect(aw.namespace).toBe('named');
    expect(aw.version).toBe(2);
    expect(aw.entries.length).toBe(4);

    const classEntry = aw.entries.find((e) => e.targetType === 'class');
    expect(classEntry).toBeDefined();
    // Slashes, exactly as written: access wideners are a slash-only format.
    expect(classEntry?.className).toBe('net/minecraft/entity/Entity');

    const methodEntry = aw.entries.find((e) => e.targetType === 'method');
    expect(methodEntry).toBeDefined();
    expect(methodEntry?.memberName).toBe('tick');

    const mutableEntry = aw.entries.find((e) => e.accessType === 'mutable');
    expect(mutableEntry).toBeDefined();
  });

  it('should skip comments and empty lines', () => {
    const awService = getAccessWidenerService();

    const content = `
accessWidener v2 named

# This is a comment
accessible class net/minecraft/entity/Entity

# Another comment
accessible field net/minecraft/entity/Entity age I
`;

    const aw = awService.parseAccessWidener(content);

    expect(aw.entries.length).toBe(2);
  });

  it('should convert descriptors to readable format', () => {
    const awService = getAccessWidenerService();

    expect(awService.descriptorToReadable('I')).toBe('int');
    expect(awService.descriptorToReadable('Z')).toBe('boolean');
    expect(awService.descriptorToReadable('Ljava/lang/String;')).toBe('java.lang.String');
    expect(awService.descriptorToReadable('[I')).toBe('int[]');
    expect(awService.descriptorToReadable('(II)V')).toBe('void (int, int)');
  });

  it('should handle validate_access_widener tool (compact, verdict-first envelope)', async () => {
    const content = `
accessWidener v2 named

accessible class net/minecraft/entity/Entity
`;

    const result = await handleValidateAccessWidener({
      content,
      mcVersion: TEST_VERSION,
      mapping: TEST_MAPPING,
    });

    expect(result).toBeDefined();
    expect(result.content).toHaveLength(1);

    const data = JSON.parse(result.content[0].text);
    expect(typeof data.valid).toBe('boolean');
    expect(data.summary).toContain('1 entry');
    expect(data.version).toBe(TEST_VERSION);
    expect(data.mapping).toBe(TEST_MAPPING);
    expect(data.namespace).toBe('named');
    // Findings, when present, are one-line directive strings (no nested entry).
    for (const f of data.errors ?? []) {
      expect(typeof f.directive).toBe('string');
      expect(typeof f.line).toBe('number');
    }
  }, 30000);

  it('should handle invalid access widener gracefully', async () => {
    const result = await handleValidateAccessWidener({
      content: 'not valid access widener',
      mcVersion: TEST_VERSION,
    });

    expect(result).toBeDefined();
    expect(result.content).toHaveLength(1);

    // The garbage content is not a file path and matches no valid access/target
    // type, so the parser rejects every line — zero entries — rather than
    // producing a bogus parsed-success shape. (No throw: bad lines are skipped.)
    const data = JSON.parse(result.content[0].text);
    expect(data.summary).toContain('0 entries');
    expect(data.namespace).toBe('named');
  });

  it('generateAccessWidener produces the exact expected text and round-trips', () => {
    const awService = getAccessWidenerService();
    const entries = [
      {
        accessType: 'accessible' as const,
        targetType: 'class' as const,
        className: 'net.minecraft.entity.Entity',
      },
      {
        accessType: 'extendable' as const,
        targetType: 'method' as const,
        className: 'net.minecraft.entity.Entity',
        memberName: 'tick',
        memberDescriptor: '()V',
      },
      {
        accessType: 'mutable' as const,
        targetType: 'field' as const,
        className: 'net.minecraft.entity.Entity',
        memberName: 'age',
        memberDescriptor: 'I',
      },
    ];

    const generated = awService.generateAccessWidener(entries, 'yarn');

    // Exact output: header line + blank line + one line per entry, class paths
    // slash-separated.
    expect(generated).toBe(
      [
        'accessWidener v2 named',
        '',
        'accessible class net/minecraft/entity/Entity',
        'extendable method net/minecraft/entity/Entity tick ()V',
        'mutable field net/minecraft/entity/Entity age I',
      ].join('\n'),
    );

    // Round-trip: parsing the generated text yields the same entries (ignoring
    // the parse-added `line` field, and with class names in the slash notation
    // the format mandates — `generateAccessWidener` accepts either and always
    // emits slashes, and the parser now preserves what it reads). Covers
    // class/method/field targets and accessible/extendable/mutable access types.
    const parsed = awService.parseAccessWidener(generated);
    expect(parsed.namespace).toBe('named');
    expect(parsed.version).toBe(2);
    expect(parsed.entries).toHaveLength(3);
    expect(
      parsed.entries.map((e) => ({
        accessType: e.accessType,
        targetType: e.targetType,
        className: e.className,
        memberName: e.memberName,
        memberDescriptor: e.memberDescriptor,
      })),
    ).toEqual(entries.map((e) => ({ ...e, className: e.className.replace(/\./g, '/') })));
  });

  it('generateAccessWidener writes the mapping namespace in the header for non-yarn', () => {
    const awService = getAccessWidenerService();
    const mojmap = awService.generateAccessWidener(
      [
        {
          accessType: 'accessible' as const,
          targetType: 'class' as const,
          className: 'net.minecraft.Foo',
        },
      ],
      'mojmap',
    );
    expect(mojmap.split('\n')[0]).toBe('accessWidener v2 mojmap');
  });

  it('parseAccessWidenerFile parses a real file from disk and surfaces sourcePath', () => {
    const awService = getAccessWidenerService();
    const filePath = join(
      tmpdir(),
      `aw-${Date.now()}-${Math.random().toString(36).slice(2)}.accesswidener`,
    );
    const content = [
      'accessWidener v2 named',
      '',
      'accessible class net/minecraft/block/Block',
      'accessible method net/minecraft/block/Block getState (I)Lnet/minecraft/block/BlockState;',
    ].join('\n');
    writeFileSync(filePath, content, 'utf8');

    try {
      const aw = awService.parseAccessWidenerFile(filePath);
      expect(aw.sourcePath).toBe(filePath);
      expect(aw.namespace).toBe('named');
      expect(aw.version).toBe(2);
      expect(aw.entries).toHaveLength(2);
      expect(aw.entries[0]?.className).toBe('net/minecraft/block/Block');
      expect(aw.entries[1]?.memberName).toBe('getState');
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  it('parseAccessWidenerFile throws AccessWidenerParseError on a missing file', () => {
    const awService = getAccessWidenerService();
    const missing = join(tmpdir(), 'definitely-does-not-exist.accesswidener');
    expect(() => awService.parseAccessWidenerFile(missing)).toThrow(AccessWidenerParseError);
    expect(() => awService.parseAccessWidenerFile(missing)).toThrow(/File not found/);
  });

  it('descriptorToReadable handles mixed object/primitive params and object returns', () => {
    const awService = getAccessWidenerService();
    expect(awService.descriptorToReadable('(Ljava/lang/String;I)V')).toBe(
      'void (java.lang.String, int)',
    );
    expect(awService.descriptorToReadable('(Ljava/lang/String;)Ljava/lang/String;')).toBe(
      'java.lang.String (java.lang.String)',
    );
    expect(awService.descriptorToReadable('[[I')).toBe('int[][]');
  });

  it('descriptorToReadable terminates on malformed input (no infinite loop)', () => {
    const awService = getAccessWidenerService();
    const malformed = ['(Ljava/lang/String', 'Lnet/mc/X', '(X)V', '', '(', '[Lnet/mc/X', '(II'];
    for (const desc of malformed) {
      const out = awService.descriptorToReadable(desc);
      expect(typeof out).toBe('string');
    }
  }, 2000);
});

describe('Access Widener Validation (bytecode + descriptor matching)', () => {
  it('reports a method that is not declared in the class', () => {
    const cls = bcClass({ name: 'net/test/Caller', methods: [bcMethod('doWork', '()V')] });
    const entry = makeEntry({
      targetType: 'method',
      className: 'net.test.Caller',
      memberName: 'helper',
      memberDescriptor: '()V',
    });
    const res = validateEntryAgainstBytecode(entry, mapOf(cls));
    expect(res.errors.some((e) => e.includes('not found'))).toBe(true);
    expect(res.suggestion).toBeUndefined();
  });

  it('validates <init> constructor descriptors against the real constructor', () => {
    const cls = bcClass({ name: 'net/test/Thing', methods: [bcMethod('<init>', '(II)V')] });
    const matching = makeEntry({
      targetType: 'method',
      className: 'net.test.Thing',
      memberName: '<init>',
      memberDescriptor: '(II)V',
    });
    expect(validateEntryAgainstBytecode(matching, mapOf(cls)).errors).toEqual([]);

    const wrongArity = makeEntry({
      targetType: 'method',
      className: 'net.test.Thing',
      memberName: '<init>',
      memberDescriptor: '(I)V',
    });
    expect(
      validateEntryAgainstBytecode(wrongArity, mapOf(cls)).errors.some((e) =>
        e.includes('no overload matches'),
      ),
    ).toBe(true);
  });

  it('reports overload mismatch and lists the found overloads', () => {
    const cls = bcClass({
      name: 'net/test/Over',
      methods: [bcMethod('foo', '(I)V'), bcMethod('foo', '(Ljava/lang/String;)V')],
    });
    const entry = makeEntry({
      targetType: 'method',
      className: 'net.test.Over',
      memberName: 'foo',
      memberDescriptor: '(II)V',
    });
    const res = validateEntryAgainstBytecode(entry, mapOf(cls));
    const err = res.errors.find((e) => e.includes('no overload matches'));
    expect(err).toBeDefined();
    expect(err).toContain('(I)V');
    expect(err).toContain('(Ljava/lang/String;)V');
  });

  it('matches a correct overload by descriptor', () => {
    const cls = bcClass({
      name: 'net/test/Over',
      methods: [bcMethod('foo', '(I)V'), bcMethod('foo', '(Ljava/lang/String;)V')],
    });
    const entry = makeEntry({
      targetType: 'method',
      className: 'net.test.Over',
      memberName: 'foo',
      memberDescriptor: '(Ljava/lang/String;)V',
    });
    expect(validateEntryAgainstBytecode(entry, mapOf(cls)).errors).toEqual([]);
  });

  it('validates field descriptors (mismatch vs match)', () => {
    const cls = bcClass({ name: 'net/test/Person', fields: [bcField('age', 'I')] });
    const mismatch = makeEntry({
      targetType: 'field',
      className: 'net.test.Person',
      memberName: 'age',
      memberDescriptor: 'Ljava/lang/String;',
    });
    expect(
      validateEntryAgainstBytecode(mismatch, mapOf(cls)).errors.some((e) =>
        e.includes('descriptor mismatch'),
      ),
    ).toBe(true);

    const ok = makeEntry({
      targetType: 'field',
      className: 'net.test.Person',
      memberName: 'age',
      memberDescriptor: 'I',
    });
    expect(validateEntryAgainstBytecode(ok, mapOf(cls)).errors).toEqual([]);
  });

  it('warns on mutable for an already-non-final field', () => {
    const cls = bcClass({
      name: 'net/test/Holder',
      fields: [
        bcField('items', 'Ljava/util/List;', ['public']),
        bcField('counter', 'I', ['public']),
      ],
    });
    const items = makeEntry({
      accessType: 'mutable',
      targetType: 'field',
      className: 'net.test.Holder',
      memberName: 'items',
      memberDescriptor: 'Ljava/util/List;',
    });
    const itemsRes = validateEntryAgainstBytecode(items, mapOf(cls));
    expect(itemsRes.errors).toEqual([]);
    expect(itemsRes.warnings.some((w) => w.includes('already be mutable'))).toBe(true);
  });

  it('does not warn on mutable for a final field', () => {
    const cls = bcClass({
      name: 'net/test/Fixed',
      fields: [bcField('locked', 'I', ['public', 'final'])],
    });
    const entry = makeEntry({
      accessType: 'mutable',
      targetType: 'field',
      className: 'net.test.Fixed',
      memberName: 'locked',
      memberDescriptor: 'I',
    });
    const res = validateEntryAgainstBytecode(entry, mapOf(cls));
    expect(res.errors).toEqual([]);
    expect(res.warnings.some((w) => w.includes('already be mutable'))).toBe(false);
  });

  it('warns on extendable for a final class but not for a non-final one', () => {
    const finalCls = bcClass({ name: 'net/test/Locked', isFinal: true });
    const finalEntry = makeEntry({
      accessType: 'extendable',
      targetType: 'class',
      className: 'net.test.Locked',
    });
    expect(
      validateEntryAgainstBytecode(finalEntry, mapOf(finalCls)).warnings.some((w) =>
        w.includes('is final'),
      ),
    ).toBe(true);

    const openCls = bcClass({ name: 'net/test/Open', isFinal: false });
    const openEntry = makeEntry({
      accessType: 'extendable',
      targetType: 'class',
      className: 'net.test.Open',
    });
    expect(
      validateEntryAgainstBytecode(openEntry, mapOf(openCls)).warnings.some((w) =>
        w.includes('is final'),
      ),
    ).toBe(false);
  });

  it('suggests a similar field name when the target is missing', () => {
    const cls = bcClass({ name: 'net/test/Box', fields: [bcField('counter', 'I')] });
    const entry = makeEntry({
      accessType: 'mutable',
      targetType: 'field',
      className: 'net.test.Box',
      memberName: 'countre',
      memberDescriptor: 'I',
    });
    const res = validateEntryAgainstBytecode(entry, mapOf(cls));
    expect(res.errors.some((e) => e.includes('not found'))).toBe(true);
    expect(res.suggestion).toContain('counter');
  });

  it('finds a <clinit> static initializer present in bytecode (no false "not found")', () => {
    // Bytecode contains <clinit> when the class has a static initializer, so —
    // unlike the old decompiled-source path — it validates without error.
    const cls = bcClass({
      name: 'net/test/WithStatic',
      methods: [bcMethod('<clinit>', '()V', ['static'])],
    });
    const entry = makeEntry({
      targetType: 'method',
      className: 'net.test.WithStatic',
      memberName: '<clinit>',
      memberDescriptor: '()V',
    });
    const res = validateEntryAgainstBytecode(entry, mapOf(cls));
    expect(res.errors).toEqual([]);
  });

  it('finds an implicit record component accessor (issue #12 regression)', () => {
    // The record accessor `value()` is compiler-generated and absent from
    // decompiled source, but present in bytecode — so widening it must not be a
    // false "not found".
    const rec = bcClass({
      name: 'net/mc/ExactMatcher',
      isRecord: true,
      recordComponents: [{ name: 'value', descriptor: 'Ljava/lang/String;', signature: null }],
      canonicalConstructor: '(Ljava/lang/String;)V',
      methods: [
        bcMethod('<init>', '(Ljava/lang/String;)V', []),
        bcMethod('value', '()Ljava/lang/String;'),
      ],
    });
    const entry = makeEntry({
      accessType: 'accessible',
      targetType: 'method',
      className: 'net.mc.ExactMatcher',
      memberName: 'value',
      memberDescriptor: '()Ljava/lang/String;',
    });
    expect(validateEntryAgainstBytecode(entry, mapOf(rec)).errors).toEqual([]);
  });

  it('errors on a class absent from the JAR with a suggestion', () => {
    const res = validateEntryAgainstBytecode(
      makeEntry({ targetType: 'class', className: 'net.test.Ghost' }),
      mapOf(bcClass({ name: 'net/test/Ghosts' })),
    );
    expect(res.errors.some((e) => e.includes('Class not found'))).toBe(true);
    expect(res.suggestion).toContain('Ghosts');
  });
});

/**
 * Inherited members. Fabric's AccessWidenerClassVisitor looks a member up as
 * EntryTriple(className, name, descriptor) against the class it is visiting, and
 * AccessWidener resolves that through a plain HashMap with no superclass
 * fallback — so an entry naming a subclass for an inherited member widens
 * nothing at all. Same rule as Forge/NeoForge ATs, same shared walk.
 */
describe('Access Widener inherited members', () => {
  const BASE = bcClass({
    name: 'net/test/Base',
    methods: [bcMethod('tick', '()V', ['protected'])],
    fields: [bcField('ticks', 'I', ['private'])],
  });
  const CHILD = bcClass({ name: 'net/test/Child', superName: 'net/test/Base' });

  it('reports the declaring superclass for an inherited method', () => {
    const res = validateEntryAgainstBytecode(
      makeEntry({
        targetType: 'method',
        className: 'net/test/Child',
        memberName: 'tick',
        memberDescriptor: '()V',
      }),
      mapOf(CHILD, BASE),
    );
    expect(res.errors[0]).toContain("Method 'tick' is not declared in net/test/Child");
    expect(res.errors[0]).toContain('inherited from net/test/Base');
    expect(res.errors[0]).toContain('has no effect');
    // Corrected line keeps AW's internal-name (slash) directive form.
    expect(res.suggestion).toBe('Use: accessible method net/test/Base tick ()V');
  });

  it('reports the declaring superclass for an inherited field', () => {
    const res = validateEntryAgainstBytecode(
      makeEntry({
        accessType: 'mutable',
        targetType: 'field',
        className: 'net/test/Child',
        memberName: 'ticks',
        memberDescriptor: 'I',
      }),
      mapOf(CHILD, BASE),
    );
    expect(res.errors[0]).toContain('inherited from net/test/Base');
    expect(res.suggestion).toBe('Use: mutable field net/test/Base ticks I');
  });

  it('finds interface default methods', () => {
    const iface = bcClass({
      name: 'net/test/Tickable',
      isInterface: true,
      methods: [bcMethod('tick', '()V')],
    });
    const impl = bcClass({ name: 'net/test/Impl', interfaces: ['net/test/Tickable'] });
    const res = validateEntryAgainstBytecode(
      makeEntry({
        targetType: 'method',
        className: 'net/test/Impl',
        memberName: 'tick',
        memberDescriptor: '()V',
      }),
      mapOf(impl, iface),
    );
    expect(res.errors[0]).toContain('inherited from net/test/Tickable');
  });

  it('stays silent when the class declares the member itself', () => {
    const overriding = bcClass({
      name: 'net/test/Child',
      superName: 'net/test/Base',
      methods: [bcMethod('tick', '()V')],
    });
    const res = validateEntryAgainstBytecode(
      makeEntry({
        targetType: 'method',
        className: 'net/test/Child',
        memberName: 'tick',
        memberDescriptor: '()V',
      }),
      mapOf(overriding, BASE),
    );
    expect(res.errors).toEqual([]);
  });

  it('never blames a parent for a missing constructor', () => {
    const parent = bcClass({
      name: 'net/test/Parent',
      methods: [bcMethod('<init>', '(I)V', ['protected'])],
    });
    const child = bcClass({ name: 'net/test/Kid', superName: 'net/test/Parent' });
    const res = validateEntryAgainstBytecode(
      makeEntry({
        targetType: 'method',
        className: 'net/test/Kid',
        memberName: '<init>',
        memberDescriptor: '(I)V',
      }),
      mapOf(child, parent),
    );
    expect(res.errors[0]).toContain('not found');
    expect(res.errors[0]).not.toContain('inherited');
  });

  it('still reports plain "not found" when no ancestor declares it', () => {
    const res = validateEntryAgainstBytecode(
      makeEntry({
        targetType: 'field',
        className: 'net/test/Child',
        memberName: 'nope',
        memberDescriptor: 'I',
      }),
      mapOf(CHILD, BASE),
    );
    expect(res.errors[0]).toBe("Field 'nope' not found in net/test/Child");
  });
});

// --- Tool-level output rendering --------------------------------------------
//
// Everything above proves the FINDING is produced. These prove it survives
// `handleValidateAccessWidener`'s compact() mapping into the JSON an LLM
// actually reads — a finding that never reaches the output is indistinguishable
// from no finding at all. The pre-existing tool tests only assert the envelope
// shape (`typeof valid === 'boolean'`), so nothing pinned the payload.

/** Stage the committed stub JAR as a version key's remapped JAR (no remapping). */
function stageRemappedStub(version: string, mapping: string): () => void {
  const jarPath = getRemappedJarPath(version, mapping);
  ensureDir(dirname(jarPath));
  copyFileSync(FIXTURE_JAR, jarPath);
  return () => {
    rmSync(jarPath, { force: true });
    // The dumper writes a sidecar next to the JAR; leaving it litters the
    // shared cache and would shadow a later real JAR under the same key.
    rmSync(jarPath.replace(/\.jar$/i, '.bytecode.json'), { force: true });
  };
}

describe('validate_access_widener tool output', () => {
  it('echoes directives in slash notation so they can be pasted back', async () => {
    // Fabric's AccessWidenerReader hard-errors on dotted class names ("Class-
    // names must be specified as a/b/C, not a.b.C"), so a dotted directive in
    // our output is not merely cosmetic — pasting it breaks the build.
    const line = 'accessible class net/minecraft/entity/Entity';
    const result = await handleValidateAccessWidener({
      content: `accessWidener v2 named\n${line}\n`,
      mcVersion: '0.0.0-never-decompiled',
      mapping: 'mojmap',
    });

    const data = JSON.parse(result.content[0].text);
    for (const finding of [...(data.errors ?? []), ...(data.warnings ?? [])]) {
      expect(finding.directive).not.toMatch(/\bnet\.minecraft\./);
    }
  }, 30000);

  it('reports missing bytecode as a verdict, not a tool error', async () => {
    const result = await handleValidateAccessWidener({
      content: 'accessWidener v2 named\naccessible class net/minecraft/entity/Entity\n',
      mcVersion: '0.0.0-never-decompiled',
      mapping: 'mojmap',
    });

    // The tool RAN; the widener is what's unverifiable. Flipping isError here
    // would surface as a broken tool rather than an actionable next step.
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(false);
    expect(data.errors[0].message).toContain('decompile_minecraft_version');
  }, 30000);

  it('accepts a file path as content, not just inline text', async () => {
    const file = join(tmpdir(), `aw-tool-${process.pid}.accesswidener`);
    writeFileSync(file, 'accessWidener v2 named\naccessible class net/minecraft/entity/Entity\n');
    try {
      const result = await handleValidateAccessWidener({
        content: file,
        mcVersion: TEST_VERSION,
        mapping: TEST_MAPPING,
      });
      const data = JSON.parse(result.content[0].text);
      // Proves the existsSync(content) branch parsed the FILE: inline-parsing a
      // path string yields zero entries, so the count is the discriminator.
      expect(data.summary).toContain('1 entry');
      expect(data.namespace).toBe('named');
    } finally {
      rmSync(file, { force: true });
    }
  }, 30000);
});

const describeRendered =
  nodeExistsSync(DUMPER_JAR) && nodeExistsSync(FIXTURE_JAR) ? describe : describe.skip;

describeRendered('validate_access_widener tool output (real stub bytecode)', () => {
  const VERSION = '0.0.0-aw-tool-test';
  const MAPPING = 'mojmap';
  const PKG = 'net/minecraft/world/level/storage/loot/predicates';
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = stageRemappedStub(VERSION, MAPPING);
  });
  afterEach(() => cleanup());

  it('surfaces the inherited-member fix as a pasteable directive', async () => {
    // `terms` is declared on CompositeLootItemCondition; an AW naming the
    // subclass widens nothing at all.
    const line = `accessible field ${PKG}/AnyOfCondition terms Ljava/util/List;`;
    const result = await handleValidateAccessWidener({
      content: `accessWidener v2 named\n${line}\n`,
      mcVersion: VERSION,
      mapping: MAPPING,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(false);
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].line).toBe(2);
    expect(data.errors[0].directive).toBe(line);
    expect(data.errors[0].message).toContain('inherited from');
    expect(data.errors[0].message).toContain(`${PKG}/CompositeLootItemCondition`);
    // The whole point: the user can paste this over their broken line.
    expect(data.errors[0].suggestion).toContain(
      `accessible field ${PKG}/CompositeLootItemCondition terms Ljava/util/List;`,
    );
  }, 60000);

  it('stays clean for a member the named class declares itself', async () => {
    const result = await handleValidateAccessWidener({
      content: `accessWidener v2 named\naccessible field ${PKG}/CompositeLootItemCondition terms Ljava/util/List;\n`,
      mcVersion: VERSION,
      mapping: MAPPING,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.valid).toBe(true);
    expect(data.summary).toContain('0 errors');
    expect(data.errors).toBeUndefined();
  }, 60000);
});
