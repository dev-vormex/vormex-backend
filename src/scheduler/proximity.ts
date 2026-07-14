import { getProximityQueue, proximityQueueNames } from '../infrastructure/proximity/queues';
import { PROXIMITY_DIRTY_PARTITIONS } from '../infrastructure/proximity/redis-keys';

export async function registerProximitySchedulerJobs(): Promise<void> {
  const maintenance = getProximityQueue(proximityQueueNames.maintenance);
  for (let partition = 0; partition < PROXIMITY_DIRTY_PARTITIONS; partition += 1) {
    await maintenance.upsertJobScheduler(`proximity-flush-${partition}`, { every: 15_000 },
      { name: 'proximity-flush-dirty-partition', data: { partition }, opts: { removeOnComplete: 20, removeOnFail: 100 } });
  }
  await maintenance.upsertJobScheduler('proximity-expire-sessions', { every: 60_000 }, { name: 'proximity-expire-sessions' });
  await maintenance.upsertJobScheduler('proximity-cleanup-geo', { every: 60_000 }, { name: 'proximity-cleanup-geo' });
  await maintenance.upsertJobScheduler('proximity-cleanup', { every: 3_600_000 }, { name: 'proximity-cleanup' });
}
