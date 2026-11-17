import { describe, expect, it } from 'vitest';
import { buildVineflowerArgs } from '../../src/java/vineflower.js';

describe('buildVineflowerArgs', () => {
  const input = 'C:/cache/remapped/1.12.2-mcp.jar';
  const output = 'C:/cache/decompiled/1.12.2/mcp';

  it('keeps the default decompiler options', () => {
    const args = buildVineflowerArgs(input, output, { renameVariables: false });

    expect(args).toContain('-dgs=1');
    expect(args).toContain('-hdc=0');
    expect(args).toContain('-asc=1');
    expect(args).toContain('-rsy=1');
    expect(args).toContain('-lit=1');
    expect(args).toContain('-thr=4');
    expect(args).not.toContain('--variable-renaming=jad');
    expect(args).not.toContain('--rename-parameters=true');
  });

  it('enables JAD renaming for parameter and local names when requested', () => {
    const args = buildVineflowerArgs(input, output, { renameVariables: true });

    // Both flags are required: variable-renaming alone leaves parameters
    // named from the (placeholder) debug tables.
    expect(args).toContain('--variable-renaming=jad');
    expect(args).toContain('--rename-parameters=true');
  });

  it('passes the input JAR then the output directory last', () => {
    const args = buildVineflowerArgs(input, output, { renameVariables: true });

    expect(args.at(-2)).toBe(input);
    expect(args.at(-1)).toBe(output);
  });

  it('preserves caller overrides', () => {
    const args = buildVineflowerArgs(input, output, {
      renameVariables: false,
      decompileGenerics: false,
      removeSynthetic: false,
      threads: 8,
      indent: '    ',
    });

    expect(args).toContain('-dgs=0');
    expect(args).toContain('-rsy=0');
    expect(args).toContain('-thr=8');
    expect(args).toContain('-ind=    ');
  });
});
