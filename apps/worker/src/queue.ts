import { Queue, Worker, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import { env } from './lib/env.js';
import { runPipeline, type PipelineJob } from './jobs/pipeline.js';

// BullMQ reserves ':' as its Redis key separator and rejects it in queue and job ids.
export const QUEUE_NAME = 'reellipi-pipeline';

/** BullMQ requires this to be null — it does its own blocking-command retry handling. */
const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

export const pipelineQueue = new Queue<PipelineJob>(QUEUE_NAME, { connection });

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
};

export async function enqueuePipeline(job: PipelineJob): Promise<string> {
  // Job id is the project id, so a double-click cannot queue the same render twice.
  const id = `${job.projectId}-${job.stage ?? 'full'}`;
  const queued = await pipelineQueue.add('process', job, { ...DEFAULT_JOB_OPTIONS, jobId: id });
  return queued.id ?? id;
}

export function startWorker(): Worker<PipelineJob> {
  const worker = new Worker<PipelineJob>(
    QUEUE_NAME,
    async (job) => {
      console.log(`[queue] processing ${job.id}`);
      await runPipeline(job.data);
    },
    {
      connection,
      // ffmpeg is CPU-bound; more concurrency than cores just adds contention.
      concurrency: Number(process.env.RENDER_CONCURRENCY ?? 2),
      lockDuration: 10 * 60_000,
    },
  );

  worker.on('completed', (job) => console.log(`[queue] completed ${job.id}`));
  worker.on('failed', (job, err) => console.error(`[queue] failed ${job?.id}: ${err.message}`));
  return worker;
}

export async function closeQueue(): Promise<void> {
  await pipelineQueue.close();
  connection.disconnect();
}
