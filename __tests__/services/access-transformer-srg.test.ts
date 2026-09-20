import { describe, expect, it } from 'vitest';
import type {
  BytecodeClass,
  BytecodeField,
  BytecodeMethod,
} from '../../src/java/bytecode-dumper.js';
import {
  type ClassBytecodeMap,
  getAccessTransformerService,
  isSrgMemberName,
  translateSrgMemberNames,
  validateEntryAgainstBytecode,
} from '../../src/services/access-transformer-service.js';
import type { AccessTransformerEntry } from '../../src/types/minecraft.js';

/**
 * SRG member-name resolution for legacy Forge access transformers.
 *
 * Pre-1.17 Forge AT files name members by SRG id 鈥?the name the member has in
 * Forge's compiled workspace:
 *
 *     public net.minecraft.client.Minecraft field_71428_T
 *
 * The class names are already readable (pre-1.14 JARs obfuscate members only),
 * but `field_71428_T` is not the name that appears in the MCP-named JAR this
 * validator reads. Without translation EVERY entry in such a file reported
 * "not found", which made the tool useless for exactly the versions whose
 * mappings it supports.
 *
 * These tests use the pure seams 鈥?no Java, no JAR, no network.
 */

// --- bytecode fixtures -----------------------------------------------------

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

/** Index an entry the test just created, failing loudly instead of with `!`. */
function entryAt(entries: AccessTransformerEntry[], index: number): AccessTransformerEntry {
  const entry = entries[index];
  if (!entry) throw new Error(`Expected an access transformer entry at index ${index}`);
  return entry;
}

/** The MCP-named shape of `net.minecraft.client.Minecraft`: field `timer`. */
const MINECRAFT = bcClass({
  name: 'net/minecraft/client/Minecraft',
  fields: [bcField('timer', 'F', ['public'])],
  methods: [bcMethod('runTick', '()V')],
});

/** A table shaped like `mcp_stable`'s fields.csv / methods.csv. */
const NAMES = {
  fields: new Map([
    ['field_71428_T', 'timer'],
    ['field_71431_Q', 'rightClickDelayTimer'],
  ]),
  methods: new Map([['func_71407_l', 'runTick']]),
};

describe('isSrgMemberName', () => {
  it('accepts SRG field and method ids', () => {
    expect(isSrgMemberName('field_71428_T')).toBe(true);
    expect(isSrgMemberName('func_71407_l')).toBe(true);
    expect(isSrgMemberName('field_1234_a')).toBe(true);
  });

  it('rejects readable MCP names and lookalikes', () => {
    expect(isSrgMemberName('timer')).toBe(false);
    expect(isSrgMemberName('field_')).toBe(false);
    expect(isSrgMemberName('field_abc_X')).toBe(false);
    expect(isSrgMemberName('myfield_71428_T')).toBe(false);
    expect(isSrgMemberName('p_71428_1_')).toBe(false);
  });
});

describe('translateSrgMemberNames', () => {
  const service = getAccessTransformerService();

  it('maps field and method ids onto their MCP names', () => {
    const parsed = service.parseAccessTransformer(
      [
        '# Legacy Mod access transformer',
        'public net.minecraft.client.Minecraft field_71428_T',
        'public net.minecraft.client.Minecraft func_71407_l()V',
        'public net.minecraft.world.World',
      ].join('\n'),
    );

    const resolution = translateSrgMemberNames(parsed.entries, NAMES);

    expect(resolution.entries.map((e) => e.memberName)).toEqual(['timer', 'runTick', undefined]);
    expect(resolution.translations.map((t) => `${t.from}->${t.to}`)).toEqual([
      'field_71428_T->timer',
      'func_71407_l->runTick',
    ]);
    expect(resolution.unresolvedSrgNames).toEqual([]);
  });

  it('keeps the entry the user wrote reachable from the resolved entry', () => {
    const parsed = service.parseAccessTransformer(
      'public net.minecraft.client.Minecraft field_71428_T\n',
    );

    const resolution = translateSrgMemberNames(parsed.entries, NAMES);
    const resolved = resolution.entries[0];
    const original = resolved && resolution.originalOf.get(resolved);

    // Findings must be reported against the user's own line, not the internal
    // MCP name 鈥?otherwise the tool answers with a directive they never wrote.
    expect(original).toBe(parsed.entries[0]);
    expect(original?.memberName).toBe('field_71428_T');
    expect(original?.line).toBe(1);
  });

  it('mirrors the input order so several files can be split back apart', () => {
    const first = service.parseAccessTransformer(
      'public net.minecraft.client.Minecraft field_71428_T\n',
    );
    const second = service.parseAccessTransformer(
      'public net.minecraft.client.Minecraft func_71407_l()V\n',
    );

    const resolution = translateSrgMemberNames([...first.entries, ...second.entries], NAMES);

    expect(resolution.entries).toHaveLength(2);
    expect(resolution.entries.slice(0, first.entries.length)[0]?.memberName).toBe('timer');
    expect(resolution.entries.slice(first.entries.length)[0]?.memberName).toBe('runTick');
  });

  it('leaves an unknown SRG id verbatim and records it', () => {
    const parsed = service.parseAccessTransformer(
      'public net.minecraft.client.Minecraft field_99999_z\n',
    );

    const resolution = translateSrgMemberNames(parsed.entries, NAMES);

    expect(resolution.entries[0]?.memberName).toBe('field_99999_z');
    expect(resolution.unresolvedSrgNames.map((u) => u.name)).toEqual(['field_99999_z']);
    expect(resolution.translations).toEqual([]);
  });

  it('never rewrites a readable MCP name even if it looks like a mapping key', () => {
    const parsed = service.parseAccessTransformer('public net.minecraft.client.Minecraft timer\n');
    const resolution = translateSrgMemberNames(parsed.entries, NAMES);

    expect(resolution.entries[0]).toBe(parsed.entries[0]);
    expect(resolution.entries[0]?.memberName).toBe('timer');
  });
});

describe('end-to-end effect on validation', () => {
  const service = getAccessTransformerService();
  const classMap = mapOf(MINECRAFT);

  it('fails an SRG-named entry when it is not translated', () => {
    // The pre-fix behavior, pinned so a regression is visible.
    const parsed = service.parseAccessTransformer(
      'public net.minecraft.client.Minecraft field_71428_T\n',
    );
    const result = validateEntryAgainstBytecode(entryAt(parsed.entries, 0), classMap);

    expect(result.errors.join(' ')).toMatch(/'field_71428_T' not found/);
  });

  it('validates the same entry once its SRG id is resolved', () => {
    const parsed = service.parseAccessTransformer(
      'public net.minecraft.client.Minecraft field_71428_T\n',
    );
    const resolution = translateSrgMemberNames(parsed.entries, NAMES);
    const result = validateEntryAgainstBytecode(
      entryAt(resolution.entries, 0),
      classMap,
      resolution.entries,
    );

    expect(result.errors).toEqual([]);
  });

  it('resolves a method id together with its descriptor', () => {
    const parsed = service.parseAccessTransformer(
      'public net.minecraft.client.Minecraft func_71407_l()V\n',
    );
    const resolution = translateSrgMemberNames(parsed.entries, NAMES);
    const result = validateEntryAgainstBytecode(entryAt(resolution.entries, 0), classMap);

    expect(result.errors).toEqual([]);
  });

  it('still reports a genuinely missing member after translation', () => {
    // `field_71431_Q` resolves to a name this class does not declare, so the
    // entry must fail 鈥?translation must not paper over real mistakes.
    const parsed = service.parseAccessTransformer(
      'public net.minecraft.client.Minecraft field_71431_Q\n',
    );
    const resolution = translateSrgMemberNames(parsed.entries, NAMES);
    const result = validateEntryAgainstBytecode(entryAt(resolution.entries, 0), classMap);

    expect(result.errors.join(' ')).toMatch(/'rightClickDelayTimer' not found/);
  });
});
