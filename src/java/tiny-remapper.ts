import { dirname } from 'node:path';
import { getJavaResourceDownloader } from '../downloaders/java-resources.js';
import { RemappingError } from '../utils/errors.js';
import { ensureDir } from '../utils/file-utils.js';
import { logger } from '../utils/logger.js';
import { executeJavaProcess } from './java-process.js';

export interface TinyRemapperOptions {
  fromNamespace: string;
  toNamespace: string;
  threads?: number;
  rebuildSourceFilenames?: boolean;
  ignoreConflicts?: boolean;
  /**
   * Match fields ignoring their descriptors. Required for SRG-based MCP
   * mappings (1.12.2 and earlier), whose `FD:` lines carry no descriptors —
   * tiny-remapper otherwise throws "null src field desc".
   */
  ignoreFieldDesc?: boolean;
  /**
   * Classpath JARs for inheritance resolution when the input references
   * classes it does not contain (positional args after `<to>`).
   */
  classpath?: string[];
  onProgress?: (progress: string) => void;
}

/**
 * TinyRemapper wrapper for JAR remapping
 */
export class TinyRemapperWrapper {
  private jarPath: string | null = null;

  /**
   * Ensure tiny-remapper JAR is downloaded
   */
  private async ensureJar(): Promise<string> {
    if (!this.jarPath) {
      const downloader = getJavaResourceDownloader();
      this.jarPath = await downloader.getTinyRemapperJar();
    }
    return this.jarPath;
  }

  /**
   * Remap a JAR file using Tiny mappings
   */
  async remap(
    inputJar: string,
    outputJar: string,
    mappingsFile: string,
    options: TinyRemapperOptions,
  ): Promise<void> {
    const jarPath = await this.ensureJar();
    ensureDir(dirname(outputJar));

    const {
      fromNamespace,
      toNamespace,
      threads = 4,
      rebuildSourceFilenames = true,
      ignoreConflicts = false,
      ignoreFieldDesc = false,
      classpath,
      onProgress,
    } = options;

    // Build tiny-remapper arguments
    // Format: <input> <output> <mappings> <from> <to> [<classpath>]... [--option=value]
    const args: string[] = [inputJar, outputJar, mappingsFile, fromNamespace, toNamespace];

    // Classpath JARs let the remapper resolve inheritance for classes the
    // input references but does not contain (e.g. remapping a mod against
    // the vanilla JAR).
    if (classpath) {
      args.push(...classpath);
    }

    // Options must use --option=value format (NOT --option value)
    if (threads > 1) {
      args.push(`--threads=${threads}`);
    }

    if (rebuildSourceFilenames) {
      args.push('--rebuildSourceFilenames');
    }

    if (ignoreConflicts) {
      args.push('--ignoreConflicts');
    }

    if (ignoreFieldDesc) {
      args.push('--ignorefielddesc');
    }

    logger.info(`Remapping JAR: ${inputJar} -> ${outputJar}`);
    logger.info(`Mappings: ${mappingsFile} (${fromNamespace} -> ${toNamespace})`);

    try {
      await executeJavaProcess(jarPath, args, {
        maxMemory: '4G',
        minMemory: '1G',
        timeout: 20 * 60 * 1000, // 20 minutes
        onStdout: (data) => {
          if (onProgress) {
            onProgress(data.trim());
          }

          // Log progress indicators
          if (data.includes('Remapping')) {
            logger.debug(`TinyRemapper: ${data.trim()}`);
          }
        },
        onStderr: (data) => {
          // tiny-remapper logs to stderr by default
          logger.debug(`TinyRemapper: ${data.trim()}`);

          if (onProgress) {
            onProgress(data.trim());
          }
        },
      });

      logger.info(`Remapping successful: ${outputJar}`);
    } catch (error) {
      logger.error('Remapping failed', error);
      throw new RemappingError(
        inputJar,
        `${fromNamespace}->${toNamespace}`,
        `TinyRemapper failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}

// Singleton instance
let tinyRemapperInstance: TinyRemapperWrapper | undefined;

export function getTinyRemapper(): TinyRemapperWrapper {
  if (!tinyRemapperInstance) {
    tinyRemapperInstance = new TinyRemapperWrapper();
  }
  return tinyRemapperInstance;
}
