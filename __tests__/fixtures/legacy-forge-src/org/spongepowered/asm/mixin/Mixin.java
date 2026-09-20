package org.spongepowered.asm.mixin;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Stub of Mixin's `@Mixin`, reduced to the elements the analyzer reads.
 *
 * CLASS retention is deliberate and matches the real annotation: it lands in
 * `RuntimeInvisibleAnnotations`, NOT the runtime-visible attribute. A reader
 * that only looks at `RuntimeVisibleAnnotations` silently extracts zero mixin
 * targets, so the fixture pins that behavior.
 */
@Retention(RetentionPolicy.CLASS)
@Target(ElementType.TYPE)
public @interface Mixin {
  Class<?>[] value() default {};

  String[] targets() default {};
}
