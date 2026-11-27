import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getDefaultRetentionMaxAgeHours,
  runRetentionSweep,
  type RetentionSweepSummary,
} from '@/lib/ops/retention';

export interface RetentionCliOptions {
  dryRun: boolean;
  maxAgeHoursAfterCreation: number;
  protectIncompleteStories: boolean;
  json: boolean;
  help: boolean;
}

export class RetentionCliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetentionCliArgError';
  }
}

const USAGE_TEXT = `Usage: npx tsx scripts/retention-sweep.ts [options]

Automated GDPR/RODO child reference photo retention sweep.

Options:
  --dry-run                Report eligible stories without deleting files
  --max-age-hours=<N>      Minimum story age in hours before purging (default: env or 720)
  --max-age-hours <N>      Same as above (space-separated)
  --include-incomplete     Also purge stories not yet in 'complete' stage
  --json                   Output full RetentionSweepSummary as JSON
  -h, --help               Show this help message
`;

function parseNonNegativeHours(raw: string, flagName: string): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new RetentionCliArgError(`Missing numeric value for ${flagName}.`);
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 24 * 365 * 5) {
    throw new RetentionCliArgError(
      `Invalid value "${raw}" for ${flagName}. Expected finite number in range 0..43800.`,
    );
  }
  return value;
}

export function parseRetentionCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): RetentionCliOptions {
  let dryRun = false;
  let maxAgeHoursAfterCreation = getDefaultRetentionMaxAgeHours(env);
  let protectIncompleteStories = true;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--include-incomplete') {
      protectIncompleteStories = false;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('--max-age-hours=')) {
      maxAgeHoursAfterCreation = parseNonNegativeHours(
        arg.slice('--max-age-hours='.length),
        '--max-age-hours',
      );
    } else if (arg === '--max-age-hours') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new RetentionCliArgError('Missing numeric value after --max-age-hours.');
      }
      maxAgeHoursAfterCreation = parseNonNegativeHours(next, '--max-age-hours');
      i += 1;
    } else {
      throw new RetentionCliArgError(`Unknown argument: "${arg}". Use --help for usage.`);
    }
  }

  return {
    dryRun,
    maxAgeHoursAfterCreation,
    protectIncompleteStories,
    json,
    help,
  };
}

function formatHumanSummary(summary: RetentionSweepSummary): string {
  const modeLabel = summary.dryRun ? 'DRY RUN' : 'LIVE';
  const lines = [
    `[retention-sweep] mode=${modeLabel} executedAt=${summary.executedAt}`,
    `  policy: maxAgeHours=${summary.policy.maxAgeHoursAfterCreation} protectIncomplete=${summary.policy.protectIncompleteStories}`,
    `  scanned=${summary.scanned} eligible=${summary.eligible} purged=${summary.purged} errors=${summary.errors}`,
    `  skipped: alreadyPurged=${summary.skippedAlreadyPurged} tooRecent=${summary.skippedTooRecent} incomplete=${summary.skippedIncomplete} lockedByOrder=${summary.skippedLockedByOrder}`,
  ];
  return lines.join('\n');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: RetentionCliOptions;
  try {
    options = parseRetentionCliArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(USAGE_TEXT);
    return 0;
  }

  try {
    const summary = await runRetentionSweep({
      dryRun: options.dryRun,
      maxAgeHoursAfterCreation: options.maxAgeHoursAfterCreation,
      protectIncompleteStories: options.protectIncompleteStories,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatHumanSummary(summary)}\n`);
    }

    return summary.errors > 0 ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[retention-sweep] fatal error: ${message}\n`);
    return 1;
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
