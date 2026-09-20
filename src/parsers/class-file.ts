/**
 * Minimal JVM `.class` reader for mod JAR analysis.
 *
 * Deliberately dependency-free (no Java, no ASM): `analyze_mod_jar` must work
 * on any machine, including ones without a JDK, and must not spin up a JVM to
 * read a mod's own metadata. The bundled ASM `bytecode-dumper` stays reserved
 * for *Minecraft* bytecode validation, where exact signatures matter.
 *
 * What this reads, and why each part matters:
 * - access flags / superclass / interfaces — class shape for the analysis
 *   report, plus legacy coremod and tweaker discovery (a `1.7.10` coremod is
 *   identified by the FML interfaces it implements, not by any metadata file).
 * - class-level `RuntimeVisibleAnnotations` — `@Mod` (the authoritative Forge
 *   mod id, and the only source of one for gradle `-dev` jars that ship no
 *   `mcmod.info`) and `@Mixin` (targets).
 *
 * Everything is bounds-checked and the entry point is total: a malformed or
 * unexpected class yields `null` instead of throwing, because one odd class in
 * a 12,000-class mod must not fail the analysis.
 */

/** A decoded annotation element value. */
export type AnnotationValue =
  | { kind: 'string'; value: string }
  | { kind: 'class'; value: string }
  | { kind: 'enum'; type: string; value: string }
  | { kind: 'annotation'; value: ParsedAnnotation }
  | { kind: 'array'; value: AnnotationValue[] }
  | { kind: 'bool'; value: boolean }
  | { kind: 'number'; value: number };

export interface ParsedAnnotation {
  /** JVM descriptor, e.g. `Lnet/minecraftforge/fml/common/Mod;`. */
  descriptor: string;
  /** Element name -> value (`value`, `targets`, `priority`, ...). */
  values: Map<string, AnnotationValue>;
}

export interface ClassFileInfo {
  /** Dotted class name, e.g. `com.example.MyMod`. */
  className: string;
  /** Dotted superclass name (`java.lang.Object` for a root class). */
  superName?: string;
  /** Dotted interface names. */
  interfaces: string[];
  accessFlags: number;
  isInterface: boolean;
  isAbstract: boolean;
  isEnum: boolean;
  isAnnotation: boolean;
  isFinal: boolean;
  isSynthetic: boolean;
  isRecord: boolean;
  methodCount: number;
  fieldCount: number;
  annotations: ParsedAnnotation[];
}

/** Access-flag bits (JVMS table 4.1-B). */
const ACC_PUBLIC = 0x0001;
const ACC_FINAL = 0x0010;
const ACC_INTERFACE = 0x0200;
const ACC_ABSTRACT = 0x0400;
const ACC_SYNTHETIC = 0x1000;
const ACC_ANNOTATION = 0x2000;
const ACC_ENUM = 0x4000;

/** Bounds-checked big-endian cursor over the class bytes. */
class ByteReader {
  private pos = 0;

  constructor(private readonly buf: Buffer) {}

  get offset(): number {
    return this.pos;
  }

  private need(bytes: number): void {
    if (this.pos + bytes > this.buf.length) {
      throw new RangeError('Unexpected end of class file');
    }
  }

  u1(): number {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }

  u2(): number {
    this.need(2);
    const value = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return value;
  }

  u4(): number {
    this.need(4);
    const value = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return value;
  }

  skip(bytes: number): void {
    this.need(bytes);
    this.pos += bytes;
  }

  /** Raw sub-buffer of `length` bytes for a nested attribute parse. */
  slice(length: number): Buffer {
    this.need(length);
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }
}

interface ConstantPool {
  tags: number[];
  utf8: string[];
  /** For CONSTANT_Integer (tag 3) — annotation booleans and numeric elements. */
  intValues: number[];
  /** For CONSTANT_Class: index of its Utf8 name. */
  classNameIndex: number[];
}

function readConstantPool(reader: ByteReader): ConstantPool {
  const count = reader.u2();
  const tags = new Array<number>(count).fill(0);
  const utf8 = new Array<string>(count).fill('');
  const intValues = new Array<number>(count).fill(0);
  const classNameIndex = new Array<number>(count).fill(0);

  for (let i = 1; i < count; i++) {
    const tag = reader.u1();
    tags[i] = tag;
    switch (tag) {
      case 1: {
        const length = reader.u2();
        utf8[i] = reader.slice(length).toString('utf8');
        break;
      }
      case 3: // Integer — required for annotation `Z`/`I`/`B`/`C`/`S` elements
        intValues[i] = reader.u4() | 0;
        break;
      case 4: // Float
        reader.skip(4);
        break;
      case 5: // Long
      case 6: // Double
        reader.skip(8);
        i++; // occupies two constant-pool slots
        break;
      case 7: // Class
        classNameIndex[i] = reader.u2();
        break;
      case 8: // String
      case 16: // MethodType
      case 19: // Module
      case 20: // Package
        reader.skip(2);
        break;
      case 15: // MethodHandle
        reader.skip(3);
        break;
      case 9: // Fieldref
      case 10: // Methodref
      case 11: // InterfaceMethodref
      case 12: // NameAndType
      case 17: // Dynamic
      case 18: // InvokeDynamic
        reader.skip(4);
        break;
      default:
        throw new Error(`Unsupported constant pool tag ${tag}`);
    }
  }

  return { tags, utf8, intValues, classNameIndex };
}

/** Resolve a constant-pool Class entry to a dotted class name. */
function classAt(pool: ConstantPool, index: number): string | undefined {
  if (pool.tags[index] !== 7) return undefined;
  const name = pool.utf8[pool.classNameIndex[index]];
  return name ? name.replace(/\//g, '.') : undefined;
}

/**
 * Decode a class *descriptor* into a dotted name. A `c` (class) annotation
 * element stores a return descriptor — `Lnet/minecraft/world/World;` — not a
 * bare internal name, and it may be an array (`[L...;`).
 *
 * The result stays in the JAR's own name space: for a Fabric mod that is
 * intermediary (`net.minecraft.class_4970`), for a Forge mod SRG/readable
 * names. Translating further needs a Minecraft version, which analysis does not
 * have — `find_mapping` bridges the rest.
 */
function classDescriptorToDotted(descriptor: string): string {
  let text = descriptor;
  let dimensions = 0;
  while (text.startsWith('[')) {
    dimensions++;
    text = text.slice(1);
  }
  if (text.startsWith('L') && text.endsWith(';')) text = text.slice(1, -1);
  const dotted = text.replace(/\//g, '.');
  return dimensions > 0 ? `${dotted}${'[]'.repeat(dimensions)}` : dotted;
}

/** Parse one `element_value` structure (JVMS 4.7.16.1). */
function readElementValue(reader: ByteReader, pool: ConstantPool): AnnotationValue {
  const tag = String.fromCharCode(reader.u1());
  switch (tag) {
    case 'B':
    case 'C':
    case 'D':
    case 'F':
    case 'I':
    case 'J':
    case 'S':
      // Numeric constants share a constant-pool entry; the declared element
      // type carries the width, which mod metadata never depends on.
      return { kind: 'number', value: pool.intValues[reader.u2()] ?? 0 };
    case 'Z': {
      const index = reader.u2();
      return { kind: 'bool', value: (pool.intValues[index] ?? 0) !== 0 };
    }
    case 's': {
      const index = reader.u2();
      return { kind: 'string', value: pool.utf8[index] ?? '' };
    }
    case 'c': {
      const index = reader.u2();
      return { kind: 'class', value: classDescriptorToDotted(pool.utf8[index] ?? '') };
    }
    case 'e': {
      const typeIndex = reader.u2();
      const nameIndex = reader.u2();
      return {
        kind: 'enum',
        type: (pool.utf8[typeIndex] ?? '').replace(/\//g, '.'),
        value: pool.utf8[nameIndex] ?? '',
      };
    }
    case '@':
      return { kind: 'annotation', value: readAnnotation(reader, pool) };
    case '[': {
      const count = reader.u2();
      const values: AnnotationValue[] = [];
      for (let i = 0; i < count; i++) values.push(readElementValue(reader, pool));
      return { kind: 'array', value: values };
    }
    default:
      throw new Error(`Unsupported annotation element tag '${tag}'`);
  }
}

/** Parse one `annotation` structure. */
function readAnnotation(reader: ByteReader, pool: ConstantPool): ParsedAnnotation {
  const typeIndex = reader.u2();
  const pairs = reader.u2();
  const values = new Map<string, AnnotationValue>();
  for (let i = 0; i < pairs; i++) {
    const nameIndex = reader.u2();
    const name = pool.utf8[nameIndex] ?? '';
    values.set(name, readElementValue(reader, pool));
  }
  return { descriptor: pool.utf8[typeIndex] ?? '', values };
}

/** Skip a `field_info` / `method_info` member (access, name, desc, attributes). */
function skipMember(reader: ByteReader): void {
  reader.skip(6); // access_flags, name_index, descriptor_index
  const attributes = reader.u2();
  for (let i = 0; i < attributes; i++) {
    reader.skip(2); // attribute_name_index
    const length = reader.u4();
    reader.skip(length);
  }
}

/**
 * Parse a class file's identity, shape and class-level runtime annotations.
 * Returns `null` when the bytes are not a readable class file.
 */
export function parseClassFile(data: Buffer): ClassFileInfo | null {
  if (data.length < 10 || data.readUInt32BE(0) !== 0xcafebabe) return null;

  try {
    const reader = new ByteReader(data);
    reader.skip(4); // magic
    reader.skip(4); // minor + major version
    const pool = readConstantPool(reader);

    const accessFlags = reader.u2();
    const thisClass = reader.u2();
    const superClass = reader.u2();

    const interfaceCount = reader.u2();
    const interfaces: string[] = [];
    for (let i = 0; i < interfaceCount; i++) {
      const name = classAt(pool, reader.u2());
      if (name) interfaces.push(name);
    }

    const fieldCount = reader.u2();
    for (let i = 0; i < fieldCount; i++) skipMember(reader);

    const methodCount = reader.u2();
    for (let i = 0; i < methodCount; i++) skipMember(reader);

    let isRecord = false;
    const annotations: ParsedAnnotation[] = [];
    const attributeCount = reader.u2();
    for (let i = 0; i < attributeCount; i++) {
      const nameIndex = reader.u2();
      const length = reader.u4();
      const name = pool.utf8[nameIndex] ?? '';
      // BOTH retention attributes must be read. Mixin's `@Mixin` is
      // `RetentionPolicy.CLASS`, so it lives in `RuntimeInvisibleAnnotations`;
      // Forge/NeoForge's `@Mod` is RUNTIME and lands in the visible one. Reading
      // only the visible attribute silently finds no mixin targets at all.
      if (name === 'RuntimeVisibleAnnotations' || name === 'RuntimeInvisibleAnnotations') {
        const body = new ByteReader(reader.slice(length));
        const count = body.u2();
        for (let j = 0; j < count; j++) annotations.push(readAnnotation(body, pool));
      } else if (name === 'Record') {
        isRecord = true;
        reader.skip(length);
      } else {
        reader.skip(length);
      }
    }

    return {
      className: classAt(pool, thisClass) ?? '',
      superName: superClass === 0 ? undefined : classAt(pool, superClass),
      interfaces,
      accessFlags,
      isInterface: (accessFlags & ACC_INTERFACE) !== 0,
      isAbstract: (accessFlags & ACC_ABSTRACT) !== 0,
      isEnum: (accessFlags & ACC_ENUM) !== 0,
      isAnnotation: (accessFlags & ACC_ANNOTATION) !== 0,
      isFinal: (accessFlags & ACC_FINAL) !== 0,
      isSynthetic: (accessFlags & ACC_SYNTHETIC) !== 0,
      isRecord,
      methodCount,
      fieldCount,
      annotations,
    };
  } catch {
    return null;
  }
}

/** Access-flag names, in the order the previous implementation reported them. */
export function accessFlagNames(accessFlags: number): string[] {
  const names: string[] = [];
  if (accessFlags & ACC_PUBLIC) names.push('public');
  if (accessFlags & ACC_FINAL) names.push('final');
  if (accessFlags & 0x0020) names.push('super');
  if (accessFlags & ACC_INTERFACE) names.push('interface');
  if (accessFlags & ACC_ABSTRACT) names.push('abstract');
  if (accessFlags & ACC_SYNTHETIC) names.push('synthetic');
  if (accessFlags & ACC_ANNOTATION) names.push('annotation');
  if (accessFlags & ACC_ENUM) names.push('enum');
  return names;
}

/** `@Mixin` descriptor (Mixin's `Mixin` annotation lives in one package across versions). */
export const MIXIN_DESCRIPTOR = 'Lorg/spongepowered/asm/mixin/Mixin;';

/**
 * Forge/NeoForge `@Mod` descriptors by era:
 * - `cpw.mods.fml.common.Mod` — Forge 1.7.10
 * - `net.minecraftforge.fml.common.Mod` — Forge 1.8 – 1.20.x
 * - `net.neoforged.fml.common.Mod` — NeoForge
 *
 * Matched by EXACT descriptor so `Mod$EventBusSubscriber` is not mistaken for
 * a mod declaration.
 */
const MOD_DESCRIPTORS = new Set([
  'Lcpw/mods/fml/common/Mod;',
  'Lnet/minecraftforge/fml/common/Mod;',
  'Lnet/neoforged/fml/common/Mod;',
]);

/** Simple names of FML interfaces/superclasses that mark a legacy coremod or tweaker. */
const COREMOD_MARKERS = new Set(['IFMLLoadingPlugin', 'DummyModContainer', 'ITweaker']);

function simpleName(dotted: string): string {
  const slash = dotted.lastIndexOf('.');
  const tail = slash >= 0 ? dotted.slice(slash + 1) : dotted;
  const dollar = tail.lastIndexOf('$');
  return dollar >= 0 ? tail.slice(dollar + 1) : tail;
}

function stringsOf(value: AnnotationValue | undefined): string[] {
  if (!value) return [];
  if (value.kind === 'string') return [value.value];
  if (value.kind === 'class') return [value.value];
  if (value.kind === 'array') return value.value.flatMap(stringsOf);
  return [];
}

function annotationByDescriptor(
  info: ClassFileInfo,
  descriptor: string,
): ParsedAnnotation | undefined {
  return info.annotations.find((annotation) => annotation.descriptor === descriptor);
}

/**
 * `@Mixin` targets: the `targets` string list plus the `value` class list.
 * Both are normalized to dotted names — note `targets` is a raw string that may
 * still use slashes, and `value` may be a single class or an array.
 */
export function extractMixinTargets(info: ClassFileInfo): string[] {
  const mixin = annotationByDescriptor(info, MIXIN_DESCRIPTOR);
  if (!mixin) return [];
  const targets = new Set<string>();
  for (const raw of stringsOf(mixin.values.get('targets'))) {
    const normalized = raw.replace(/\//g, '.');
    if (normalized) targets.add(normalized);
  }
  for (const raw of stringsOf(mixin.values.get('value'))) {
    if (raw) targets.add(raw.replace(/\//g, '.'));
  }
  return [...targets];
}

/** Is this class annotated with Forge/NeoForge `@Mod`? */
export function hasModAnnotation(info: ClassFileInfo): boolean {
  return info.annotations.some((annotation) => MOD_DESCRIPTORS.has(annotation.descriptor));
}

/**
 * The mod id declared by `@Mod`. Forge 1.7.10 used the `modid` element; 1.8+
 * uses `value` (which is also where the shorthand `@Mod("id")` lands).
 */
export function extractModAnnotationId(info: ClassFileInfo): string | undefined {
  for (const annotation of info.annotations) {
    if (!MOD_DESCRIPTORS.has(annotation.descriptor)) continue;
    for (const key of ['value', 'modid']) {
      const raw = annotation.values.get(key);
      if (raw?.kind === 'string' && raw.value.trim()) return raw.value.trim();
    }
  }
  return undefined;
}

/**
 * Is this class a legacy coremod / tweaker? Forge 1.7.10–1.12.2 coremods are
 * identified by the FML interfaces they implement (there is no metadata file
 * field for the class name); the manifest `FMLCorePlugin` attribute then names
 * the same class.
 */
export function isCoremodClass(info: ClassFileInfo): boolean {
  const candidates = [...info.interfaces, ...(info.superName ? [info.superName] : [])];
  return candidates.some((name) => COREMOD_MARKERS.has(simpleName(name)));
}
