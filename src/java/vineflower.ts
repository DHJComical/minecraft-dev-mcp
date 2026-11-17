import { getJavaResourceDownloader } from '../downloaders/java-resources.js';
import { PLACEHOLDER_NAME_CHAR, hasPlaceholderDebugNames } from '../utils/debug-names.js';
import { DecompilationError } from '../utils/errors.js';
import { ensureDir } from '../utils/file-utils.js';
import { logger } from '../utils/logger.js';
import { executeJavaProcess } from './java-process.js';

export interface VineflowerOptions {
  decompileGenerics?: boolean; // -dgs=1
  hideDefaultConstructor?: boolean; // -hdc=0
  asciiStrings?: boolean; // -asc=1
  removeSynthetic?: boolean; // -rsy=1
  literalsAsIs?: boolean; // -lit=1
  indent?: string; // -ind="  "
  threads?: number; // -thr=4
  /**
   * Use Vineflower's type-derived JAD renamer instead of the JAR's debug names.
   *
   * When omitted, it is enabled automatically for JARs whose debug-name tables
   * hold Mojang's U+2603 placeholder — see `utils/debug-names.ts`. Modern
   * (unobfuscated) JARs keep their real names, so this stays opt-out for them.
   */
  renameVariables?: boolean;
  onProgress?: (current: number, total: number) => void;
}

/**
 * Build the Vineflower CLI arguments.
 *
 * Exported for tests: the naming flags are the part that decides whether
 * decompiled output is readable, so they should not be buried in `decompile()`.
 */
export function buildVineflowerArgs(
  inputJar: string,
  outputDir: string,
  options: VineflowerOptions & { renameVariables: boolean },
): string[] {
  const {
    decompileGenerics = true,
    hideDefaultConstructor = false,
    asciiStrings = true,
    removeSynthetic = true,
    literalsAsIs = true,
    indent = '  ',
    threads = 4,
    renameVariables,
  } = options;

  const args: string[] = [
    // Options
    `-dgs=${decompileGenerics ? 1 : 0}`,
    `-hdc=${hideDefaultConstructor ? 1 : 0}`,
    `-asc=${asciiStrings ? 1 : 0}`,
    `-rsy=${removeSynthetic ? 1 : 0}`,
    `-lit=${literalsAsIs ? 1 : 0}`,
    `-ind=${indent}`,
    `-thr=${threads}`,
  ];

  if (renameVariables) {
    // JAD-style naming derives names from types (`block`, `iblockstate`, `i`),
    // which is the only readable option when the JAR's own names are the U+2603
    // placeholder. `--rename-parameters` is required: variable-renaming alone
    // leaves parameters untouched, and parameters are where most placeholders live.
    args.push('--variable-renaming=jad', '--rename-parameters=true');
  }

  // Input and output
  args.push(inputJar, outputDir);
  return args;
}

/**
 * Vineflower decompiler wrapper
 */
export class VineflowerWrapper {
  private jarPath: string | null = null;

  /**
   * Ensure Vineflower JAR is downloaded
   */
  private async ensureJar(): Promise<string> {
    if (!this.jarPath) {
      const downloader = getJavaResourceDownloader();
      this.jarPath = await downloader.getVineflowerJar();
    }
    return this.jarPath;
  }

  /**
   * Decompile a JAR file
   */
  async decompile(
    inputJar: string,
    outputDir: string,
    options: VineflowerOptions = {},
  ): Promise<void> {
    const jarPath = await this.ensureJar();
    ensureDir(outputDir);

    const { onProgress, renameVariables } = options;

    // Obfuscated Minecraft JARs ship U+2603 as every debug name, which decompiles
    // into unreadable, colliding identifiers. Detect that once per JAR and fall
    // back to type-derived names; JARs with real debug names are unaffected.
    const useRenamer = renameVariables ?? hasPlaceholderDebugNames(inputJar);
    if (useRenamer) {
      logger.info(
        `Placeholder debug names (${PLACEHOLDER_NAME_CHAR}) detected in ${inputJar} — using JAD-style variable renaming`,
      );
    }

    const args = buildVineflowerArgs(inputJar, outputDir, {
      ...options,
      renameVariables: useRenamer,
    });

    logger.info(`Decompiling with Vineflower: ${inputJar} -> ${outputDir}`);

    try {
      let classesProcessed = 0;
      let totalClasses = 0;

      await executeJavaProcess(jarPath, args, {
        maxMemory: '4G',
        minMemory: '1G',
        timeout: 30 * 60 * 1000, // 30 minutes for large JARs
        onStdout: (data) => {
          // Parse progress from Vineflower output
          // Example: "Decompiling class 1234/5678 ..."
          const match = data.match(/Decompiling class (\d+)\/(\d+)/);
          if (match) {
            classesProcessed = Number.parseInt(match[1], 10);
            totalClasses = Number.parseInt(match[2], 10);

            if (onProgress && totalClasses > 0) {
              onProgress(classesProcessed, totalClasses);
            }
          }

          // Also check for completion message
          if (data.includes('Finished decompilation')) {
            logger.info('Vineflower decompilation completed');
          }
        },
        onStderr: (data) => {
          // Log warnings but don't fail
          if (data.includes('WARN')) {
            logger.warn(`Vineflower warning: ${data.trim()}`);
          }
        },
      });

      logger.info(`Decompilation successful: ${outputDir}`);
    } catch (error) {
      logger.error('Decompilation failed', error);
      throw new DecompilationError(
        inputJar,
        `Vineflower decompilation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Decompile a single class from a JAR
   */
  async decompileClass(inputJar: string, className: string, outputDir: string): Promise<string> {
    // Vineflower doesn't support single-class decompilation directly
    // We need to decompile the whole JAR (but it's cached)
    await this.decompile(inputJar, outputDir);

    // Return path to decompiled class
    const classPath = `${className.replace(/\./g, '/')}.java`;
    return `${outputDir}/${classPath}`;
  }
}

// Singleton instance
let vineflowerInstance: VineflowerWrapper | undefined;

export function getVineflower(): VineflowerWrapper {
  if (!vineflowerInstance) {
    vineflowerInstance = new VineflowerWrapper();
  }
  return vineflowerInstance;
}
