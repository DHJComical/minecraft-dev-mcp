import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  BytecodeClass,
  BytecodeField,
  BytecodeMethod,
} from '../../src/java/bytecode-dumper.js';
import { getBytecodeDumper } from '../../src/java/bytecode-dumper.js';
import {
  type ClassBytecodeMap,
  detectAccessTransformerConflicts,
  validateEntryAgainstBytecode,
} from '../../src/services/access-transformer-service.js';
import type { AccessTransformerEntry } from '../../src/types/minecraft.js';

/**
 * Inherited-member resolution and cross-file conflicts (issue #12).
 *
 * An access transformer only transforms the class it NAMES. A directive aimed
 * at a member the class merely inherits is silently inert — it compiles, it
 * loads, and the member stays inaccessible, which is the failure mode rlnt
 * described as "parent classes also need access transformation". The validator
 * must therefore distinguish "no such member" from "declared on a parent" and
 * hand back the corrected directive.
 *
 * These run against hand-built bytecode fixtures through the pure
 * `validateEntryAgainstBytecode` seam — no Java, no JAR — except the last block,
 * which pins the same behaviour against the real committed stub JAR.
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

function makeEntry(partial: Partial<AccessTransformerEntry>): AccessTransformerEntry {
  return {
    modifier: { access: 'public', final: 'none' },
    memberType: 'class',
    className: 'net.test.X',
    line: 1,
    ...partial,
  };
}

function bcMethod(name: string, desc: string, flags: string[] = ['public']): BytecodeMethod {
  return { name, desc, access: 0, flags, signature: null, exceptions: [] };
}

function bcField(name: string, desc = 'I', flags: string[] = ['private']): BytecodeField {
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

function mapOf(...classes: BytecodeClass[]): ClassBytecodeMap {
  return new Map(classes.map((c) => [c.name, c]));
}

// Base declares tick()V and a `terms` field; Child declares neither.
const BASE = bcClass({
  name: 'net/test/Base',
  methods: [bcMethod('tick', '()V', ['protected'])],
  fields: [bcField('terms', 'Ljava/util/List;', ['protected', 'final'])],
});
const CHILD = bcClass({ name: 'net/test/Child', superName: 'net/test/Base' });

describe('inherited members (an AT only transforms the class it names)', () => {
  it('reports the declaring superclass for an inherited method, with the fixed directive', () => {
    const res = validateEntryAgainstBytecode(
      makeEntry({
        memberType: 'method',
        className: 'net.test.Child',
        memberName: 'tick',
        memberDescriptor: '()V',
      }),
      mapOf(CHILD, BASE),
    );

    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain("'tick' is not declared in net.test.Child");
    expect(res.errors[0]).toContain('inherited from net.test.Base');
    expect(res.errors[0]).toContain('has no effect');
    // The corrected line must be paste-ready: same modifier + descriptor, new class.
    expect(res.suggestion).toBe('Use: public net.test.Base tick()V');
  });

  it('reports the declaring superclass for an inherited field', () => {
    const res = validateEntryAgainstBytecode(
      makeEntry({ memberType: 'field', className: 'net.test.Child', memberName: 'terms' }),
      mapOf(CHILD, BASE),
    );

    expect(res.errors[0]).toContain("Field 'terms' is not declared in net.test.Child");
    expect(res.errors[0]).toContain('inherited from net.test.Base');
    expect(res.suggestion).toBe('Use: public net.test.Base terms');
  });

  it('stays silent when the class declares (overrides) the member itself', () => {
    const overriding = bcClass({
      name: 'net/test/Child',
      superName: 'net/test/Base',
      methods: [bcMethod('tick', '()V')],
    });
    const res = validateEntryAgainstBytecode(
      makeEntry({
        memberType: 'method',
        className: 'net.test.Child',
        memberName: 'tick',
        memberDescriptor: '()V',
      }),
      mapOf(overriding, BASE),
    );
    expect(res.errors).toEqual([]);
  });

  it('walks the full chain, not just the immediate parent', () => {
    const mid = bcClass({ name: 'net/test/Mid', superName: 'net/test/Base' });
    const leaf = bcClass({ name: 'net/test/Leaf', superName: 'net/test/Mid' });
    const res = validateEntryAgainstBytecode(
      makeEntry({
        memberType: 'method',
        className: 'net.test.Leaf',
        memberName: 'tick',
        memberDescriptor: '()V',
      }),
      mapOf(leaf, mid, BASE),
    );
    expect(res.errors[0]).toContain('inherited from net.test.Base');
  });

  it('finds interface default methods too', () => {
    const iface = bcClass({
      name: 'net/test/Tickable',
      isInterface: true,
      methods: [bcMethod('tick', '()V')],
    });
    const impl = bcClass({ name: 'net/test/Impl', interfaces: ['net/test/Tickable'] });
    const res = validateEntryAgainstBytecode(
      makeEntry({
        memberType: 'method',
        className: 'net.test.Impl',
        memberName: 'tick',
        memberDescriptor: '()V',
      }),
      mapOf(impl, iface),
    );
    expect(res.errors[0]).toContain('inherited from net.test.Tickable');
  });

  it('prefers the inherited-member error over a descriptor mismatch', () => {
    // Child has its own `tick(I)V`; the AT asks for `tick()V`, which is the
    // parent's overload. "No overload matches" would send the user hunting for
    // a typo in the descriptor instead of retargeting the class.
    const child = bcClass({
      name: 'net/test/Child',
      superName: 'net/test/Base',
      methods: [bcMethod('tick', '(I)V')],
    });
    const res = validateEntryAgainstBytecode(
      makeEntry({
        memberType: 'method',
        className: 'net.test.Child',
        memberName: 'tick',
        memberDescriptor: '()V',
      }),
      mapOf(child, BASE),
    );
    expect(res.errors[0]).toContain('inherited from net.test.Base');
    expect(res.errors[0]).not.toContain('no overload matches');
  });

  it('still reports plain "not found" when no ancestor declares it', () => {
    const res = validateEntryAgainstBytecode(
      makeEntry({
        memberType: 'method',
        className: 'net.test.Child',
        memberName: 'nope',
        memberDescriptor: '()V',
      }),
      mapOf(CHILD, BASE),
    );
    expect(res.errors[0]).toBe("Method 'nope' not found in net.test.Child");
    expect(res.errors[0]).not.toContain('inherited');
  });

  it('degrades quietly when the parent is outside the JAR', () => {
    // java/lang/* and library types are never dumped. The walk must stop at the
    // edge of what we can see rather than inventing a "missing class" error.
    const orphan = bcClass({ name: 'net/test/Orphan', superName: 'com/external/Lib' });
    const res = validateEntryAgainstBytecode(
      makeEntry({
        memberType: 'field',
        className: 'net.test.Orphan',
        memberName: 'whatever',
      }),
      mapOf(orphan),
    );
    expect(res.errors[0]).toBe("Field 'whatever' not found in net.test.Orphan");
  });

  it('never blames a parent for a missing constructor', () => {
    // Constructors are not inherited: the parent's <init> is a different
    // constructor, so "add it to the parent instead" would be wrong advice.
    const parent = bcClass({
      name: 'net/test/Parent',
      methods: [bcMethod('<init>', '(I)V', ['protected'])],
    });
    const child = bcClass({ name: 'net/test/Kid', superName: 'net/test/Parent' });
    const res = validateEntryAgainstBytecode(
      makeEntry({
        memberType: 'method',
        className: 'net.test.Kid',
        memberName: '<init>',
        memberDescriptor: '(I)V',
      }),
      mapOf(child, parent),
    );
    expect(res.errors[0]).toBe("Method '<init>' not found in net.test.Kid");
    expect(res.errors[0]).not.toContain('inherited');
  });

  it('terminates on a cyclic hierarchy', () => {
    const a = bcClass({ name: 'net/test/A', superName: 'net/test/B' });
    const b = bcClass({ name: 'net/test/B', superName: 'net/test/A' });
    const res = validateEntryAgainstBytecode(
      makeEntry({ memberType: 'field', className: 'net.test.A', memberName: 'x' }),
      mapOf(a, b),
    );
    expect(res.errors[0]).toContain('not found');
  });
});

describe('cross-file access transformer conflicts', () => {
  const inFile = (file: string, line: number, access: 'public' | 'protected') =>
    makeEntry({
      modifier: { access, final: 'none' },
      memberType: 'field',
      className: 'net.test.Foo',
      memberName: 'bar',
      line,
      sourceFile: file,
    });

  it('names both files when two ATs fight over the same target', () => {
    const a = inFile('a.cfg', 3, 'public');
    const b = inFile('b.cfg', 7, 'protected');
    const res = detectAccessTransformerConflicts([a, b]);

    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.message).toContain("'public' vs 'protected'");
    expect(res.errors[0]?.message).toContain('a.cfg:3');
    expect(res.errors[0]?.message).toContain('b.cfg:7');
    expect(res.errors[0]?.message).toContain('different files');
  });

  it('flags a duplicate that spans two files as redundant, not conflicting', () => {
    const res = detectAccessTransformerConflicts([
      inFile('a.cfg', 1, 'public'),
      inFile('b.cfg', 2, 'public'),
    ]);
    expect(res.errors).toEqual([]);
    expect(res.warnings[0]?.message).toContain('Duplicate');
    expect(res.warnings[0]?.message).toContain('b.cfg:2');
  });

  it('reports only findings involving the file under validation', () => {
    // b.cfg and c.cfg fight over net.test.Other; a.cfg has nothing to do with
    // it. Validating a.cfg must not re-report someone else's argument — each
    // sibling reports its own when it is the one being validated.
    const a = inFile('a.cfg', 1, 'public');
    const b = makeEntry({
      memberType: 'field',
      className: 'net.test.Other',
      memberName: 'baz',
      line: 1,
      sourceFile: 'b.cfg',
    });
    const c = makeEntry({
      modifier: { access: 'protected', final: 'none' },
      memberType: 'field',
      className: 'net.test.Other',
      memberName: 'baz',
      line: 4,
      sourceFile: 'c.cfg',
    });

    expect(detectAccessTransformerConflicts([a, b, c], new Set([a])).errors).toEqual([]);

    // ...but validating b.cfg surfaces it, so the conflict is never lost.
    const fromB = detectAccessTransformerConflicts([b, a, c], new Set([b]));
    expect(fromB.errors).toHaveLength(1);
    expect(fromB.errors[0]?.message).toContain('c.cfg:4');
  });

  it('reports every sibling that clashes with the validated file', () => {
    const a = inFile('a.cfg', 1, 'public');
    const b = inFile('b.cfg', 1, 'protected');
    const c = inFile('c.cfg', 1, 'private');

    const fromA = detectAccessTransformerConflicts([a, b, c], new Set([a]));
    expect(fromA.errors).toHaveLength(2);
    expect(fromA.errors.every((e) => e.message.includes('a.cfg:1'))).toBe(true);
  });

  it('leaves single-file messages unchanged when no file is known', () => {
    const one = makeEntry({
      memberType: 'field',
      className: 'net.test.Foo',
      memberName: 'bar',
      line: 1,
    });
    const two = makeEntry({
      modifier: { access: 'protected', final: 'none' },
      memberType: 'field',
      className: 'net.test.Foo',
      memberName: 'bar',
      line: 2,
    });
    const res = detectAccessTransformerConflicts([one, two]);
    expect(res.errors[0]?.message).toContain('line 1 vs line 2');
    expect(res.errors[0]?.message).not.toContain('different files');
  });

  it('suppresses the record-ctor note when a sibling file widens the constructor', () => {
    const record = bcClass({
      name: 'net/test/Rec',
      isRecord: true,
      canonicalConstructor: '(I)V',
      methods: [bcMethod('<init>', '(I)V', ['private'])],
    });
    const classEntry = makeEntry({ className: 'net.test.Rec', sourceFile: 'a.cfg' });
    const ctorInOtherFile = makeEntry({
      memberType: 'method',
      className: 'net.test.Rec',
      memberName: '<init>',
      memberDescriptor: '(I)V',
      sourceFile: 'b.cfg',
    });

    // Alone: the note fires.
    expect(
      validateEntryAgainstBytecode(classEntry, mapOf(record), [classEntry]).warnings,
    ).toHaveLength(1);

    // With the sibling file's ctor directive in the union: it does not, because
    // every AT is applied together at build time.
    expect(
      validateEntryAgainstBytecode(classEntry, mapOf(record), [classEntry, ctorInOtherFile])
        .warnings,
    ).toEqual([]);
  });
});

// --- Same behaviour, real bytecode ------------------------------------------
//
// The committed stub reproduces vanilla 1.21.1 shapes, including a real
// hierarchy: AnyOfCondition -> CompositeLootItemCondition -> LootItemCondition.
// `terms` is declared on the composite parent, so an AT naming AnyOfCondition is
// exactly the inert directive this feature exists to catch.
const describeReal = existsSync(DUMPER_JAR) && existsSync(FIXTURE_JAR) ? describe : describe.skip;

describeReal('inherited members against the real stub JAR', () => {
  const PKG = 'net.minecraft.world.level.storage.loot.predicates';

  it('catches a field the AT targets on the subclass instead of its declarer', async () => {
    const dump = await getBytecodeDumper().dump(FIXTURE_JAR);
    const classMap: ClassBytecodeMap = new Map(dump.classes.map((c) => [c.name, c]));

    const res = validateEntryAgainstBytecode(
      makeEntry({
        memberType: 'field',
        className: `${PKG}.AnyOfCondition`,
        memberName: 'terms',
      }),
      classMap,
    );

    expect(res.errors[0]).toContain('inherited from');
    expect(res.errors[0]).toContain('CompositeLootItemCondition');
    expect(res.suggestion).toBe(`Use: public ${PKG}.CompositeLootItemCondition terms`);
  }, 60000);

  it('does not flag a member the targeted class declares itself', async () => {
    const dump = await getBytecodeDumper().dump(FIXTURE_JAR);
    const classMap: ClassBytecodeMap = new Map(dump.classes.map((c) => [c.name, c]));

    // AnyOfCondition declares its own package-private constructor.
    const res = validateEntryAgainstBytecode(
      makeEntry({
        memberType: 'method',
        className: `${PKG}.AnyOfCondition`,
        memberName: '<init>',
        memberDescriptor: '(Ljava/util/List;)V',
      }),
      classMap,
    );
    expect(res.errors).toEqual([]);
  }, 60000);
});
