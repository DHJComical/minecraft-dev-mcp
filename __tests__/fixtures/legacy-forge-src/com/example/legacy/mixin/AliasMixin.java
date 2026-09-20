package com.example.legacy.mixin;

import org.spongepowered.asm.mixin.Mixin;

/** Mixin targeting by CLASS LITERAL, which is stored as a `c` annotation element. */
@Mixin(WorldMixin.class)
public class AliasMixin {
  public void onTick() {}
}
