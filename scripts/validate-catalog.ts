import { auditThemeCatalog } from '../src/lib/catalog/validator';

async function main(): Promise<void> {
  const report = await auditThemeCatalog();
  console.log(
    JSON.stringify(
      {
        valid: report.valid,
        totalThemes: report.totalThemes,
        evergreenCount: report.evergreenCount,
        seasonalCount: report.seasonalCount,
        seasonalCoveragePercent: report.seasonalCoveragePercent,
        uncoveredDaysCount: report.uncoveredDaysOfYear.length,
        errors: report.errors,
        warnings: report.warnings,
      },
      null,
      2,
    ),
  );

  if (!report.valid) {
    process.exitCode = 1;
  }
}

void main();
