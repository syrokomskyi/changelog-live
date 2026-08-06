/*
<MODULE_CONTRACT>
<purpose>Provides leveled logging (quiet, normal, verbose) for the changelog pipeline</purpose>
<non-goals>
  <item>Does not handle file-based logging or log rotation</item>
  <item>Does not implement structured logging or log levels beyond the three modes</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>ADR-0005: Initial implementation of leveled logger for CLI UX overrides</item>
</CHANGE_SUMMARY>
*/

export type LogLevel = "quiet" | "normal" | "verbose";

export interface Logger {
  /** Verbose-level message — only shown in --verbose mode. Use for debug detail (commits, AI prompts, timing). */
  verbose(msg: string): void;
  /** Info-level message — shown in normal and verbose modes, suppressed in --quiet. Use for progress summaries. */
  info(msg: string): void;
  /** Error message — always shown, even in --quiet. */
  error(msg: string): void;
}

class LeveledLogger implements Logger {
  constructor(private readonly level: LogLevel) {}

  verbose(msg: string): void {
    if (this.level === "verbose") {
      console.log(msg);
    }
  }

  info(msg: string): void {
    if (this.level !== "quiet") {
      console.log(msg);
    }
  }

  error(msg: string): void {
    console.error(msg);
  }
}

const NOOP_LOGGER: Logger = {
  verbose() {},
  info() {},
  error(msg: string) {
    console.error(msg);
  },
};

/**
 * Create a logger for the given verbosity level.
 * - "quiet" — only errors
 * - "normal" — info + errors (default)
 * — "verbose" — verbose + info + errors
 */
export function createLogger(level: LogLevel): Logger {
  return new LeveledLogger(level);
}

/**
 * A logger that suppresses all output except errors.
 * Useful for tests and programmatic callers.
 */
export const silentLogger: Logger = NOOP_LOGGER;
