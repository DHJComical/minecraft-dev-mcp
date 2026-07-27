/**
 * Class-hierarchy walking over dumped bytecode.
 *
 * Shared by the access-transformer and access-widener validators because both
 * formats have the SAME rule: an entry modifies only the class it names.
 *
 * Access transformers: Forge/NeoForge apply a directive to the named class
 * alone. Access wideners: Fabric's `AccessWidenerClassVisitor` looks up
 * `EntryTriple(className, name, descriptor)` for the class it is currently
 * visiting, and `AccessWidener` resolves that against a plain `HashMap` — there
 * is no superclass traversal or fallback anywhere in it.
 *
 * So in both formats, naming a subclass for a member declared on a parent is a
 * silent no-op: it compiles, it loads, and the member stays inaccessible. These
 * helpers let a validator find the real declarer and say so.
 */

import type { BytecodeClass } from '../java/bytecode-dumper.js';

/** A map of internal class name (slashes, `$`) → its authoritative bytecode metadata. */
export type ClassBytecodeMap = Map<string, BytecodeClass>;

/**
 * Walk a class's ancestors — superclass chain first, then interfaces — breadth
 * first, yielding each ancestor present in `classMap`. The starting class is NOT
 * yielded. Ancestors outside the JAR are invisible here (never dumped) and are
 * simply skipped; `seen` also makes a cyclic/malformed hierarchy terminate.
 */
export function* ancestorsOf(
  cls: BytecodeClass,
  classMap: ClassBytecodeMap,
): Generator<BytecodeClass> {
  const seen = new Set<string>([cls.name]);
  // superName before interfaces: a member found on the superclass chain is the
  // more likely intent, and is what the user must retarget.
  const queue: string[] = [cls.superName, ...cls.interfaces].filter((n): n is string => !!n);

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const ancestor = classMap.get(name);
    if (!ancestor) continue; // outside the JAR (java/lang/*, libraries)
    yield ancestor;
    for (const parent of [ancestor.superName, ...ancestor.interfaces]) {
      if (parent && !seen.has(parent)) queue.push(parent);
    }
  }
}

/**
 * Find the ancestor that actually declares a member an entry targets.
 *
 * When `descriptor` is given, an ancestor only counts if it has that exact
 * overload; otherwise the name alone is enough (access-transformer field
 * directives carry no descriptor).
 *
 * Constructors and static initializers are excluded: they are NEVER inherited,
 * so a parent's `<init>` is a different constructor entirely, and blaming it
 * would send the user to rewrite a directive that is simply targeting a
 * constructor the class does not have.
 */
export function findDeclaringAncestor(
  cls: BytecodeClass,
  classMap: ClassBytecodeMap,
  memberType: 'method' | 'field',
  memberName: string,
  descriptor?: string,
): BytecodeClass | null {
  if (memberType === 'method' && (memberName === '<init>' || memberName === '<clinit>')) {
    return null;
  }
  for (const ancestor of ancestorsOf(cls, classMap)) {
    const declares =
      memberType === 'method'
        ? ancestor.methods.some(
            (m) => m.name === memberName && (!descriptor || m.desc === descriptor),
          )
        : ancestor.fields.some((f) => f.name === memberName);
    if (declares) return ancestor;
  }
  return null;
}
