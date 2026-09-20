package net.minecraftforge.fml.common;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Stub of Forge's `@Mod`, reduced to the elements the analyzer reads.
 *
 * RUNTIME retention is what the real annotation uses (FML reflects on it at
 * load time), so the fixture exercises `RuntimeVisibleAnnotations`.
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
public @interface Mod {
  String value() default "";

  String modid() default "";

  String version() default "";
}
