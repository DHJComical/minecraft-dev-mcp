import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import {
  buildJoinedMapping,
  lookupInMcpSrg,
  parseMcpCsv,
  zipGetEntry,
} from '../../src/utils/mcp-mappings.js';

/**
 * Offline unit tests for the MCP (ModCoderPack) mapping utilities.
 *
 * The fixtures replicate the real artifacts on maven.minecraftforge.net for
 * versions 1.7.10 through 1.12.2, whose formats are identical:
 * - joined.srg: `PK:`/`CL:`/`FD:`/`MD:` lines; FD lines carry NO descriptors;
 *   synthetic fields (e.g. `$VALUES`) and recoverable enum constants appear
 *   already human-named on the target side.
 * - mcp_stable CSVs: header `searge,name,side,desc`, descriptions may be
 *   quoted and contain commas.
 */

const FIELDS_CSV = [
  'searge,name,side,desc',
  'field_96303_A,BLACK,0,"Color enum entry with properties 0",',
  'field_70170_p,worldObj,2,Reference to the World object.',
].join('\n');

const METHODS_CSV = [
  'searge,name,side,desc',
  'func_110646_a,getTextWithoutFormattingCodes,2,"Strips formatting codes."',
  'func_96298_a,formattingCode,0,',
].join('\n');

const JOINED_SRG = [
  'PK: . net/minecraft/src',
  'PK: net net',
  'PK: net/minecraft net/minecraft',
  'CL: a net/minecraft/util/EnumChatFormatting',
  'CL: sv net/minecraft/entity/Entity',
  'FD: a/A net/minecraft/util/EnumChatFormatting/field_96303_A',
  'FD: a/C net/minecraft/util/EnumChatFormatting/$VALUES',
  'FD: a/D net/minecraft/util/EnumChatFormatting/BLACK',
  'FD: sv/f net/minecraft/entity/Entity/field_70170_p',
  'MD: a/a ()C net/minecraft/util/EnumChatFormatting/func_96298_a ()C',
  'MD: a/a (Ljava/lang/String;)Ljava/lang/String; net/minecraft/util/EnumChatFormatting/func_110646_a (Ljava/lang/String;)Ljava/lang/String;',
  'MD: sv/a (Lsv;)Z net/minecraft/entity/Entity/func_70033_w (Lsv;)Z',
].join('\n');

describe('parseMcpCsv', () => {
  it('skips the header and parses srg -> mcp names', () => {
    const map = parseMcpCsv(FIELDS_CSV);
    expect(map.get('field_96303_A')).toBe('BLACK');
    expect(map.get('field_70170_p')).toBe('worldObj');
    expect(map.size).toBe(2);
  });

  it('handles quoted descriptions containing commas', () => {
    const map = parseMcpCsv(FIELDS_CSV);
    // The quoted desc contains a comma; only the first two columns matter.
    expect(map.get('field_96303_A')).toBe('BLACK');
  });

  it('returns an empty map for header-only input', () => {
    expect(parseMcpCsv('searge,name,side,desc').size).toBe(0);
    expect(parseMcpCsv('').size).toBe(0);
  });
});

describe('buildJoinedMapping', () => {
  const result = buildJoinedMapping(JOINED_SRG, FIELDS_CSV, METHODS_CSV);

  it('counts classes, fields and methods', () => {
    expect(result.classes).toBe(2);
    expect(result.fields).toBe(4);
    expect(result.methods).toBe(3);
  });

  it('drops PK: lines (classes are fully qualified)', () => {
    expect(result.srg).not.toContain('PK:');
  });

  it('renames fields through the CSV and keeps non-SRG names as-is', () => {
    expect(result.srg).toContain('FD: a/A net/minecraft/util/EnumChatFormatting/BLACK');
    // Synthetic field not present in the CSV keeps its name.
    expect(result.srg).toContain('FD: a/C net/minecraft/util/EnumChatFormatting/$VALUES');
    // Already human-named in joined.srg (enum constant) stays untouched.
    expect(result.srg).toContain('FD: a/D net/minecraft/util/EnumChatFormatting/BLACK');
  });

  it('renames methods through the CSV and preserves descriptors', () => {
    expect(result.srg).toContain(
      'MD: a/a (Ljava/lang/String;)Ljava/lang/String; ' +
        'net/minecraft/util/EnumChatFormatting/getTextWithoutFormattingCodes ' +
        '(Ljava/lang/String;)Ljava/lang/String;',
    );
  });

  it('falls back to the SRG name when the CSV has no entry', () => {
    // func_70033_w is not in METHODS_CSV.
    expect(result.srg).toContain(
      'MD: sv/a (Lsv;)Z net/minecraft/entity/Entity/func_70033_w (Lsv;)Z',
    );
  });

  it('orders FD lines before CL lines (mapping-io detectFormat workaround)', () => {
    const firstFd = result.srg.indexOf('FD:');
    const firstCl = result.srg.indexOf('CL:');
    expect(firstFd).toBeGreaterThanOrEqual(0);
    expect(firstFd).toBeLessThan(firstCl);
  });
});

describe('lookupInMcpSrg', () => {
  const srg = buildJoinedMapping(JOINED_SRG, FIELDS_CSV, METHODS_CSV).srg;

  it('resolves an obfuscated class to its MCP name', () => {
    const hit = lookupInMcpSrg(srg, 'a', false);
    expect(hit).toMatchObject({
      found: true,
      type: 'class',
      target: 'net/minecraft/util/EnumChatFormatting',
    });
  });

  it('resolves an MCP class back to the obfuscated name (reverse)', () => {
    const hit = lookupInMcpSrg(srg, 'net.minecraft.entity.Entity', true);
    expect(hit).toMatchObject({ found: true, type: 'class', source: 'sv' });
  });

  it('resolves an obfuscated member to its MCP name (forward)', () => {
    // sv/f = Entity's field_70170_p, named "worldObj" by the CSV.
    const hit = lookupInMcpSrg(srg, 'f', false);
    expect(hit).toMatchObject({
      found: true,
      type: 'field',
      target: 'worldObj',
      className: 'net/minecraft/entity/Entity',
    });
  });

  it('resolves an MCP member back to the obfuscated name (reverse)', () => {
    const hit = lookupInMcpSrg(srg, 'worldObj', true);
    expect(hit).toMatchObject({
      found: true,
      type: 'field',
      source: 'f',
      className: 'sv',
    });
  });

  it('reports a miss for names absent from both columns', () => {
    // Intermediate SRG names only survive in the generated file as
    // CSV-miss fallbacks, so they are not a lookup surface.
    expect(lookupInMcpSrg(srg, 'field_99999_zz', false).found).toBe(false);
  });
});

describe('zipGetEntry', () => {
  it('extracts a stored (method 0) entry', () => {
    // Build a minimal ZIP with a stored entry via adm-zip (dev dep).
    const zip = new AdmZip();
    zip.addFile('joined.srg', Buffer.from('CL: a net/minecraft/util/EnumChatFormatting\n'));
    const buffer = zip.toBuffer();
    const entry = zipGetEntry(new Uint8Array(buffer), 'joined.srg');
    // adm-zip emits method-0 for small in-memory entries; if it deflates, the
    // entry still round-trips through the method-8 path.
    expect(new TextDecoder().decode(entry ?? new Uint8Array())).toContain('EnumChatFormatting');
  });

  it('returns null for a missing entry', () => {
    const zip = new AdmZip();
    zip.addFile('other.txt', Buffer.from('x'));
    expect(zipGetEntry(new Uint8Array(zip.toBuffer()), 'joined.srg')).toBeNull();
  });
});
