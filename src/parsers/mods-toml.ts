/**
 * `META-INF/mods.toml` / `META-INF/neoforge.mods.toml` parser.
 *
 * Forge (1.13–1.20.x) and NeoForge (1.20.5+) declare mod metadata in a TOML
 * file. It is the modern counterpart of `mcmod.info` and carries strictly more
 * information — dependency graph with version ranges, sides, mandatory flags,
 * declared mixin configs and access transformers.
 *
 * This is a purpose-built TOML SUBSET reader, not a general TOML
 * implementation. It covers exactly what mod metadata files use:
 * top-level scalars, `[table]` / `[[array.of.tables]]` headers, basic/literal
 * strings (single- and multi-line), booleans, numbers, inline arrays and inline
 * tables. Files that use unusual TOML (dotted keys mid-file, exotic escapes)
 * still parse; the rare unsupported construct degrades to a string value rather
 * than throwing, because a metadata file must never sink an analysis.
 *
 * Being a real block parser matters for correctness: a single regex over the
 * whole file cannot tell `[[dependencies.mymod]]` blocks apart, which is why
 * `versionRange` used to be read from the wrong block and dependencies were
 * dropped entirely.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;

export interface TomlTable {
  [key: string]: TomlValue;
}

/** One `[[mods]]` entry. */
export interface ForgeModEntry {
  modId: string;
  version?: string;
  displayName?: string;
  description?: string;
  authors?: string;
  credits?: string;
  displayURL?: string;
  logoFile?: string;
  /** `[mods.features] javaVersion` (Forge 1.18+), e.g. `[17,)`. */
  javaVersion?: string;
}

/** One `[[dependencies.<owner>]]` entry. */
export interface ForgeDependencyEntry {
  /** The mod that DECLARES the dependency (the table name). */
  ownerModId: string;
  modId: string;
  /** Forge 1.13–1.20 `mandatory` flag; NeoForge 1.20.5+ expresses this via `type`. */
  mandatory: boolean;
  /** NeoForge 1.20.5+ dependency type (`required`/`optional`/`incompatible`/`discouraged`). */
  type?: string;
  versionRange?: string;
  ordering?: string;
  side?: string;
}

export interface ForgeModsToml {
  /** `modLoader` (e.g. `javafml`). */
  modLoader?: string;
  /** `loaderVersion` (e.g. `[47,)`). */
  loaderVersion?: string;
  license?: string;
  issueTrackerURL?: string;
  mods: ForgeModEntry[];
  dependencies: ForgeDependencyEntry[];
  /** `[[mixins]] config="..."` (Forge 1.20.2+ / NeoForge). */
  mixinConfigs: string[];
  /** `[[accessTransformers]] file="..."` (NeoForge 1.20.5+). */
  accessTransformerFiles: string[];
  /** Any `[mixins]`/unknown top-level keys are ignored. */
  extras?: Record<string, TomlValue>;
}

// ---------------------------------------------------------------------------
// Minimal TOML reader
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

/** Remove a UTF-8 BOM, which `toString('utf8')` keeps and TOML rejects. */
function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/** Split a dotted key on `.` while respecting quoted segments. */
function splitKeyPath(key: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '.') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

/** Index of the first `=` outside a quoted string, or -1. */
function indexOfAssignment(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '=') return i;
    if (ch === '#') return -1;
  }
  return -1;
}

/** Strip a `#` comment that is not inside a string. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return text.slice(0, i);
  }
  return text;
}

/** Decode TOML escapes in a basic (double-quoted) string body. */
function decodeBasicString(body: string): string {
  return body.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (full, esc: string) => {
    if (esc.startsWith('u') || esc.startsWith('U')) {
      const code = Number.parseInt(esc.slice(1), 16);
      return Number.isNaN(code) ? full : String.fromCodePoint(code);
    }
    return ESCAPES[esc] ?? esc;
  });
}

/**
 * Split `text` on top-level commas (commas outside strings and nested
 * brackets), used for inline arrays and tables.
 */
function splitTopLevel(text: string, separator = ','): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"') {
        current += text[i + 1] ?? '';
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Parse a TOML value expression (already multi-line-joined). */
function parseValue(text: string): TomlValue {
  const value = text.trim();
  if (value === '') return '';

  // Multi-line / single-line strings.
  for (const delim of ['"""', "'''"]) {
    if (value.startsWith(delim)) {
      const body = value.slice(3, value.length >= 6 && value.endsWith(delim) ? -3 : undefined);
      // TOML trims a newline immediately following the opening delimiter.
      const trimmed = body.startsWith('\n') ? body.slice(1) : body;
      return delim === '"""' ? decodeBasicString(trimmed) : trimmed;
    }
  }
  if (value.startsWith('"')) {
    const end = value.lastIndexOf('"');
    return decodeBasicString(end > 0 ? value.slice(1, end) : value.slice(1));
  }
  if (value.startsWith("'")) {
    const end = value.lastIndexOf("'");
    return end > 0 ? value.slice(1, end) : value.slice(1);
  }

  if (value.startsWith('[')) {
    const inner = value.replace(/^\[/, '').replace(/\]$/, '');
    return splitTopLevel(inner)
      .filter((part) => part.trim() !== '')
      .map(parseValue);
  }

  if (value.startsWith('{')) {
    const inner = value.replace(/^\{/, '').replace(/\}$/, '');
    const table: TomlTable = {};
    for (const pair of splitTopLevel(inner)) {
      const eq = indexOfAssignment(pair);
      if (eq <= 0) continue;
      const key = splitKeyPath(pair.slice(0, eq).trim()).join('.');
      if (key) table[key] = parseValue(pair.slice(eq + 1));
    }
    return table;
  }

  if (value === 'true') return true;
  if (value === 'false') return false;

  // Numbers, dates and anything exotic: keep numbers numeric, rest as text.
  if (/^[+-]?\d+$/.test(value)) {
    const num = Number.parseInt(value, 10);
    return Number.isSafeInteger(num) ? num : value;
  }
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(value)) {
    const num = Number.parseFloat(value);
    return Number.isNaN(num) ? value : num;
  }
  return value;
}

/**
 * Navigate to (creating if needed) the table at `path`.
 *
 * Array-of-tables semantics: an intermediate path segment that resolves to an
 * array means "the most recently declared element", so nested sub-tables like
 * `[mods.features]` land inside the last `[[mods]]` entry.
 */
function navigate(parent: TomlTable, path: string[]): TomlTable {
  let current = parent;
  for (const segment of path) {
    const existing = current[segment];
    if (Array.isArray(existing)) {
      const last = existing[existing.length - 1];
      if (last && typeof last === 'object' && !Array.isArray(last)) {
        current = last as TomlTable;
        continue;
      }
      const created: TomlTable = {};
      existing.push(created);
      current = created;
      continue;
    }
    if (existing && typeof existing === 'object') {
      current = existing as TomlTable;
      continue;
    }
    const created: TomlTable = {};
    current[segment] = created;
    current = created;
  }
  return current;
}

/** Append (creating if needed) an array-of-tables element at `path`. */
function appendArrayElement(root: TomlTable, path: string[]): TomlTable {
  const key = path[path.length - 1];
  if (path.length === 1 && key) {
    const existing = root[key];
    const element: TomlTable = {};
    if (Array.isArray(existing)) existing.push(element);
    else root[key] = [element];
    return element;
  }
  const parent = navigate(root, path.slice(0, -1));
  const existing = parent[key];
  const element: TomlTable = {};
  if (Array.isArray(existing)) existing.push(element);
  else parent[key] = [element];
  return element;
}

/**
 * Parse TOML text into a nested table tree. Never throws: unparseable lines are
 * skipped.
 */
export function parseToml(content: string): TomlTable {
  const root: TomlTable = {};
  const lines = stripBom(content).split(/\r?\n/);
  let current: TomlTable = root;

  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index];
    index++;
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    // --- [table] / [[array of tables]] headers ---
    if (line.startsWith('[[')) {
      const close = line.indexOf(']]');
      if (close < 0) continue;
      const path = splitKeyPath(line.slice(2, close).trim());
      if (path.length === 0) continue;
      current = appendArrayElement(root, path);
      continue;
    }
    if (line.startsWith('[')) {
      const close = line.indexOf(']');
      if (close < 0) continue;
      const path = splitKeyPath(line.slice(1, close).trim());
      if (path.length === 0) continue;
      current = navigate(root, path);
      continue;
    }

    // --- key = value ---
    const eq = indexOfAssignment(line);
    if (eq <= 0) continue;
    const keyPath = splitKeyPath(line.slice(0, eq).trim());
    if (keyPath.length === 0) continue;

    // Gather continuation lines when the value opens a multi-line string or an
    // unterminated inline array/table.
    const gathered = gatherValueLines(line.slice(eq + 1).trim(), lines, index);
    index = gathered.nextIndex;

    current[keyPath.join('.')] = parseValue(gathered.text);
  }

  return root;
}

/**
 * Extend a value expression across physical lines until it is complete:
 * multi-line strings close on their delimiter, inline arrays/tables on balanced
 * brackets, everything else is a single line. Returns the joined text plus the
 * index of the first line that was NOT consumed.
 */
function gatherValueLines(
  initial: string,
  lines: string[],
  startIndex: number,
): { text: string; nextIndex: number } {
  let text = initial;
  let index = startIndex;
  const multilineDelim = text.startsWith('"""') ? '"""' : text.startsWith("'''") ? "'''" : null;

  const isComplete = (): boolean => {
    if (multilineDelim) {
      // Closing delimiter present after the opening one.
      return text.length >= 6 && text.indexOf(multilineDelim, 3) !== -1;
    }
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\' && quote === '"') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
    }
    return depth <= 0 && !quote;
  };

  let guard = 0;
  while (!isComplete() && guard++ < 10_000) {
    if (index >= lines.length) break;
    text += `\n${lines[index]}`;
    index++;
  }

  return { text, nextIndex: index };
}

// ---------------------------------------------------------------------------
// mods.toml interpretation
// ---------------------------------------------------------------------------

function asTable(value: TomlValue | undefined): TomlTable | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as TomlTable)
    : undefined;
}

function asTableArray(value: TomlValue | undefined): TomlTable[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is TomlTable => !!item && typeof item === 'object' && !Array.isArray(item),
  );
}

function str(value: TomlValue | undefined): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

/**
 * Interpret a parsed mods.toml tree as Forge/NeoForge mod metadata.
 *
 * Dependencies are collected from every `[[dependencies.<owner>]]` block with
 * its own `mandatory`/`type`, `versionRange` and `side` — the information a
 * flat regex over the file cannot recover.
 */
export function parseModsToml(content: string): ForgeModsToml {
  const root = parseToml(content);

  const mods: ForgeModEntry[] = asTableArray(root.mods).map((entry) => {
    const features = asTable(entry.features);
    return {
      modId: str(entry.modId) ?? 'unknown',
      version: str(entry.version),
      displayName: str(entry.displayName),
      description: str(entry.description),
      authors: str(entry.authors),
      credits: str(entry.credits),
      displayURL: str(entry.displayURL),
      logoFile: str(entry.logoFile),
      javaVersion: features ? str(features.javaVersion) : undefined,
    };
  });

  const dependencies: ForgeDependencyEntry[] = [];
  const dependenciesTable = asTable(root.dependencies);
  if (dependenciesTable) {
    for (const [ownerModId, value] of Object.entries(dependenciesTable)) {
      for (const entry of asTableArray(value)) {
        const depModId = str(entry.modId);
        if (!depModId) continue;
        const type = str(entry.type);
        dependencies.push({
          ownerModId,
          modId: depModId,
          // NeoForge 1.20.5+ dropped `mandatory` in favour of `type`, where a
          // missing `mandatory` means "required".
          mandatory:
            entry.mandatory === false ? false : type !== 'optional' && type !== 'incompatible',
          type,
          versionRange: str(entry.versionRange),
          ordering: str(entry.ordering),
          side: str(entry.side),
        });
      }
    }
  }

  const mixinConfigs: string[] = [];
  for (const entry of asTableArray(root.mixins)) {
    const config = str(entry.config);
    if (config) mixinConfigs.push(config);
  }

  const accessTransformerFiles: string[] = [];
  for (const entry of asTableArray(root.accessTransformers)) {
    const file = str(entry.file);
    if (file) accessTransformerFiles.push(file);
  }

  return {
    modLoader: str(root.modLoader),
    loaderVersion: str(root.loaderVersion),
    license: str(root.license),
    issueTrackerURL: str(root.issueTrackerURL),
    mods,
    dependencies,
    mixinConfigs,
    accessTransformerFiles,
  };
}
