import { AppDataSource } from '../src/database/data-source';
import { ensureUpcomingPartitions } from '../src/jobs/create-partitions-job';

/**
 * Exercises create-partitions-job.ts (Phase 3 follow-up #1) against the
 * real e2e database. Stage 1's migration already creates partitions
 * covering 6 months back through 2 months forward of whenever it ran —
 * so against "now" this job should find nothing to do. The real thing
 * worth proving is what happens once "now" moves far enough forward
 * that new partitions genuinely don't exist yet, which is exercised
 * directly via `ensureUpcomingPartitions`'s optional `now` parameter
 * rather than by mocking the system clock.
 */
describe('Partition maintenance job (e2e)', () => {
  const createdTables: string[] = [];

  beforeAll(async () => {
    await AppDataSource.initialize();
  });

  afterAll(async () => {
    for (const table of createdTables) {
      await AppDataSource.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    await AppDataSource.destroy();
  });

  it('finds nothing to create for the current month + configured buffer, since Stage 1 already covers it', async () => {
    const result = await ensureUpcomingPartitions(new Date());
    expect(result.checked).toBeGreaterThan(0);
    expect(result.created).toEqual([]);
  });

  it('creates missing partitions once "now" is far enough forward that they genuinely do not exist yet', async () => {
    // Far enough forward (5 years) that no prior migration or job run in
    // this test DB could plausibly have already created these.
    const future = new Date(Date.UTC(2031, 5, 15)); // 2031-06-15
    const result = await ensureUpcomingPartitions(future);
    createdTables.push(...result.created);

    expect(result.created.length).toBeGreaterThan(0);
    expect(result.created).toContain('payments_partitioned_2031_06');
    expect(result.created).toContain('ledger_outbox_partitioned_2031_06');

    const [{ exists }] = await AppDataSource.query(
      `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = $1) AS exists`,
      ['payments_partitioned_2031_06'],
    );
    expect(exists).toBe(true);
  });

  it('is idempotent — re-running against the same future date creates nothing new', async () => {
    const future = new Date(Date.UTC(2031, 5, 15));
    const result = await ensureUpcomingPartitions(future);
    expect(result.created).toEqual([]);
  });
});
