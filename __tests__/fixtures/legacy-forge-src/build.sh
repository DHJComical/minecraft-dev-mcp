#!/usr/bin/env bash
# Rebuild the legacy Forge fixture JAR (1.12.2 / mcmod.info era) from the stub
# sources and metadata files.
#
# The compiled JAR (../legacy-forge-1.12.2.jar) is committed so tests do not
# need a JDK at runtime; re-run this only when the fixture changes.
# It pairs with the modern-Forge fixture (../legacy-forge-1.16.5.jar), which
# covers the META-INF/mods.toml era.
#   Requires JDK 17+. Usage: bash build.sh [output-jar]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/../legacy-forge-1.12.2.jar}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mapfile -t srcs < <(find "$here" -name '*.java')
javac -d "$tmp/classes" "${srcs[@]}"

# Metadata and resources ride at the JAR root, exactly as a real mod ships them.
cp "$here/mcmod.info" "$here/mixins.legacymod.json" "$here/legacymod_at.cfg" \
   "$here/pack.mcmeta" "$tmp/classes/"
# The same AT under META-INF as well: real legacy mods do this, and the analyzer
# must not report it twice.
mkdir -p "$tmp/classes/META-INF"
cp "$here/legacymod_at.cfg" "$tmp/classes/META-INF/legacymod_at.cfg"

( cd "$tmp/classes" && jar --create --file "$out" --manifest "$here/MANIFEST.MF" . )
echo "Wrote $out"
