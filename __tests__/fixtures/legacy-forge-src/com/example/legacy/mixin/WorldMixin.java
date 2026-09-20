package com.example.legacy.mixin;

import org.spongepowered.asm.mixin.Mixin;

/** Mixin targeting by STRING name (the legacy 0.7 style). */
@Mixin(targets = "net.minecraft.world.World")
public class WorldMixin {
  public void onTick() {}
}
