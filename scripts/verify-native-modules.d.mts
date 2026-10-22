export interface CommandSpec {
  label: string;
  command: string;
  args: string[];
  available: boolean;
}

export interface ProbeResult {
  ok: boolean;
  abi: string | null;
  detail: string;
}

export declare const projectRoot: string;
export declare const MODULE_NAME: string;
export declare const moduleDir: string;
export declare const binaryPath: string;

export declare function lastLines(text: unknown, limit?: number): string[];
export declare function looksLikeToolchainError(text: unknown): boolean;
export declare function looksLikeNetworkError(text: unknown): boolean;
export declare function summarizeFailure(text: unknown, limit?: number): string[];
export declare function electronExecutable(): string | null;
export declare function electronVersion(): string | null;
export declare function installAppDepsCommand(): CommandSpec;
export declare function electronRebuildCommand(options?: { buildFromSource?: boolean }): CommandSpec;
export declare function probeNativeModule(electron: string, target: string): ProbeResult;
