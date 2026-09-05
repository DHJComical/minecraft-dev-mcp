/**
 * MCP mappings utilities for pre-1.14.4 Minecraft versions (e.g. 1.12.2).
 *
 * Mojang does not publish `client_mappings` (official mappings) for versions
 * before 1.14.4, and Fabric's yarn/intermediary do not cover 1.12.2 either.
 * The canonical human-readable mappings for these versions are the Forge
 * MCP (ModCoderPack) mappings, distributed as:
 *
 *   - `de.oceanlabs.mcp:mcp:<version>:srg`  → ZIP containing `joined.srg`
 *     (obfuscated → SRG names, methods carry full JVM descriptors)
 *   - `de.oceanlabs.mcp:mcp_stable:<build>-<version>` → ZIP containing
 *     `fields.csv` / `methods.csv` / `params.csv` (SRG → MCP names)
 *
 * This module joins them into a single obfuscated → MCP SRG file.
 *
 * NOTE (why we generate instead of downloading): `notch-mcp.srg` / `srg-mcp.srg`
 * are generated artifacts of Forge's RFG pipeline and are not published as
 * standalone artifacts; the two artifacts above ARE published on
 * maven.minecraftforge.net, so we reconstruct the equivalent from them.
 */

import { inflateRawSync } from 'node:zlib';

/** A parsed `fields.csv` / `methods.csv` row: srgName -> mcpName. */
export type SrgToMcpMap = ReadonlyMap<string, string>;

/**
 * Parse an MCP CSV file (fields.csv / methods.csv) into an srg -> mcp map.
 * The CSV has the header `searge,name,side,desc` and rows with the srg name
 * first and the human-readable MCP name second. Descriptions may contain
 * commas, so only the first two columns are used.
 */
export function parseMcpCsv(content: string): SrgToMcpMap {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const firstComma = line.indexOf(',');
    if (firstComma < 0) continue;
    const secondComma = line.indexOf(',', firstComma + 1);
    if (secondComma < 0) continue;
    const srgName = line.slice(0, firstComma);
    let mcpName = line.slice(firstComma + 1, secondComma);
    if (mcpName.startsWith('"') && mcpName.endsWith('"')) {
      mcpName = mcpName.slice(1, -1);
    }
    if (srgName === 'searge' || srgName === 'param' || srgName.length === 0) continue;
    map.set(srgName, mcpName);
  }
  return map;
}

export interface McpJoinedMapping {
  /** Number of `CL:` entries parsed. */
  classes: number;
  /** Number of `FD:` entries parsed. */
  fields: number;
  /** Number of `MD:` entries parsed. */
  methods: number;
  /** The generated obfuscated → MCP SRG file content. */
  srg: string;
}

/**
 * Reconstruct an obfuscated → MCP `notch-mcp.srg`-style mapping from
 * `joined.srg` (obfuscated → SRG) and the MCP CSVs (SRG → MCP names).
 *
 * Format notes:
 * - `CL:` lines map obfuscated class names to MCP class names unchanged.
 * - `FD:` lines are `FD: <obfClass>/<obfField> <mcpClass>/<fieldName>` (field
 *   names are looked up through the MCP CSV; SRG field names have no desc).
 * - `MD:` lines are `MD: <obfClass>/<obfMethod> (<desc>)<obfDesc>
 *   <mcpClass>/<methodName> (<desc>)<mcpDesc>` (method names looked up
 *   through the MCP CSV; descriptors are preserved from `joined.srg`).
 *
 * The returned SRG has the `FD:` lines placed first. This is a workaround for
 * mapping-io's `detectFormat` auto-detection, which reads only the first 4096
 * chars of the file before deciding it is an SRG file; when the file starts
 * with `CL:` lines the detector can overflow its mark buffer on large files
 * and fall back to "invalid/unsupported mapping format".
 */
export function buildJoinedMapping(
  joinedSrg: string,
  fieldsCsv: string,
  methodsCsv: string,
): McpJoinedMapping {
  const fields = parseMcpCsv(fieldsCsv);
  const methods = parseMcpCsv(methodsCsv);

  const cls: string[] = [];
  const fds: string[] = [];
  const mds: string[] = [];

  for (const rawLine of joinedSrg.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith('CL:')) {
      // CL: <obfClass> <mcpClass>
      cls.push(line);
      continue;
    }
    if (line.startsWith('FD:')) {
      // FD: <obfClass>/<obfField> <mcpClass>/<srgField>
      const m = line.match(/^FD: (\S+) (\S+)\/(\S+)$/);
      if (!m) continue;
      const named = fields.get(m[3]) ?? m[3];
      fds.push(`FD: ${m[1]} ${m[2]}/${named}`);
      continue;
    }
    if (line.startsWith('MD:')) {
      // MD: <obfClass>/<obfMethod> (<desc>)<obfDesc> <mcpClass>/<srgMethod> (<desc>)<mcpDesc>
      const m = line.match(
        /^MD: (\S+)\/(\S+)\s+\(([^)]*)\)(\S+)\s+(\S+)\/(\S+)\s+\(([^)]*)\)(\S+)/,
      );
      if (!m) continue;
      const named = methods.get(m[6]) ?? m[6];
      mds.push(
        `MD: ${m[1]}/${m[2]} (${m[3]})${m[4]} ${m[5]}/${named} (${m[7]})${m[8]}`,
      );
      continue;
    }
  }

  // FD lines first (see the workaround note above), then CL, then MD.
  const ordered = [...fds, ...cls, ...mds];
  return {
    classes: cls.length,
    fields: fds.length,
    methods: mds.length,
    srg: ordered.join('\n'),
  };
}

/**
 * Minimal lookup result for an obfuscated ↔ MCP symbol lookup.
 */
export interface McpLookupHit {
  found: boolean;
  type?: 'class' | 'method' | 'field';
  source: string;
  target?: string;
  className?: string;
}

/**
 * Look up an obfuscated (or MCP) symbol in the generated obf → MCP SRG file.
 *
 * The SRG is inherently directional (obfuscated → named); reverse lookups
 * (named → obfuscated) are supported by scanning both columns.
 */
export function lookupInMcpSrg(
  srgContent: string,
  symbol: string,
  reverse: boolean,
): McpLookupHit {
  const normalized = symbol.replace(/\./g, '/');
  const shortName = normalized.includes('/')
    ? normalized.slice(normalized.lastIndexOf('/') + 1)
    : normalized;

  // Parse the SRG into a per-class structure.
  const classMap = new Map<
    string,
    { obf: string; named: string; fields: Array<[string, string]>; methods: Array<[string, string]> }
  >();
  let current: { obf: string; named: string; fields: Array<[string, string]>; methods: Array<[string, string]> } | null = null;

  for (const rawLine of srgContent.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith('CL:')) {
      const m = line.match(/^CL: (\S+) (\S+)$/);
      if (m) {
        current = { obf: m[1], named: m[2], fields: [], methods: [] };
        classMap.set(m[1], current);
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith('FD:')) {
      const m = line.match(/^FD: (\S+) (\S+)\/(\S+)$/);
      if (m) {
        current.fields.push([m[1].slice(m[1].lastIndexOf('/') + 1), m[3]]);
      }
      continue;
    }
    if (line.startsWith('MD:')) {
      const m = line.match(
        /^MD: (\S+)\/(\S+)\s+\(([^)]*)\)(\S+)\s+(\S+)\/(\S+)\s+\(([^)]*)\)(\S+)/,
      );
      if (m) {
        current.methods.push([m[2], m[6]]);
      }
    }
  }

  // Class match: full name, short name, or dotted form.
  for (const cls of classMap.values()) {
    const obfMatch = !reverse && (cls.obf === normalized || cls.obf === symbol);
    const namedMatch = reverse && (cls.named === normalized || cls.named === symbol);
    if (obfMatch || namedMatch) {
      return {
        found: true,
        type: 'class',
        source: cls.obf,
        target: cls.named,
      };
    }
  }

  // Member match: within each class, compare member names (obf side or MCP side).
  for (const cls of classMap.values()) {
    for (const [obfMember, namedMember] of cls.methods) {
      const hit = !reverse ? obfMember === shortName || obfMember === symbol : namedMember === shortName || namedMember === symbol;
      if (hit) {
        return {
          found: true,
          type: 'method',
          source: obfMember,
          target: namedMember,
          className: reverse ? cls.obf : cls.named,
        };
      }
    }
    for (const [obfMember, namedMember] of cls.fields) {
      const hit = !reverse ? obfMember === shortName || obfMember === symbol : namedMember === shortName || namedMember === symbol;
      if (hit) {
        return {
          found: true,
          type: 'field',
          source: obfMember,
          target: namedMember,
          className: reverse ? cls.obf : cls.named,
        };
      }
    }
  }

  return { found: false, source: symbol };
}

/**
 * Extract a single entry from a ZIP file's bytes without external deps.
 * Used to avoid pulling adm-zip into the download path; returns null when the
 * entry is not present.
 */
export function zipGetEntry(
  zipBuffer: Uint8Array,
  entryName: string,
): Uint8Array | null {
  const buf = Buffer.from(zipBuffer);
  let off = 0;
  while (off + 30 <= buf.length) {
    const sig = buf.readUInt32LE(off);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    if (name === entryName) {
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) {
        return new Uint8Array(data);
      }
      if (method === 8) {
        return inflateRaw(data);
      }
      throw new Error(`Unsupported ZIP compression method ${method} for ${entryName}`);
    }
    off = dataStart + compSize;
  }
  return null;
}

/** Minimal raw-DEFLATE inflater (ZIP compression method 8). */
function inflateRaw(data: Uint8Array): Uint8Array {
  return new Uint8Array(inflateRawSync(Buffer.from(data)));
}
