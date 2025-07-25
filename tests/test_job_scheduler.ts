import { expect } from 'chai';
import { default as IORedis } from 'ioredis';
import { beforeEach, describe, it, before, after as afterAll } from 'mocha';

import * as sinon from 'sinon';
import { v4 } from 'uuid';
import { rrulestr } from 'rrule';
import {
  Job,
  Queue,
  QueueEvents,
  Repeat,
  getNextMillis,
  Worker,
} from '../src/classes';
import { JobsOptions } from '../src/types';
import { delay, removeAllQueueData } from '../src/utils';

const moment = require('moment');

const ONE_SECOND = 1000;
const ONE_MINUTE = 60 * ONE_SECOND;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;

const NoopProc = async (job: Job) => {};

describe('Job Scheduler', function () {
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const prefix = process.env.BULLMQ_TEST_PREFIX || 'bull';
  this.timeout(10000);
  let repeat: Repeat;
  let queue: Queue;
  let queueEvents: QueueEvents;
  let queueName: string;

  let connection;
  before(async function () {
    connection = new IORedis(redisHost, { maxRetriesPerRequest: null });
  });

  beforeEach(async function () {
    this.clock = sinon.useFakeTimers({ shouldClearNativeTimers: true });
    queueName = `test-${v4()}`;
    queue = new Queue(queueName, { connection, prefix });
    repeat = new Repeat(queueName, { connection, prefix });
    queueEvents = new QueueEvents(queueName, { connection, prefix });
    await queue.waitUntilReady();
    await queueEvents.waitUntilReady();
  });

  afterEach(async function () {
    this.clock.restore();
    await queue.close();
    await repeat.close();
    await queueEvents.close();
    await removeAllQueueData(new IORedis(redisHost), queueName);
  });

  afterAll(async function () {
    await connection.quit();
  });

  describe('when endDate is not greater than current timestamp', () => {
    it('throws an error', async function () {
      await expect(
        queue.upsertJobScheduler('test-scheduler', {
          endDate: Date.now() - 1000,
          every: 100,
        }),
      ).to.be.rejectedWith('End date must be greater than current timestamp');
    });
  });

  it('it should stop repeating after endDate', async function () {
    const every = 100;
    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);
    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(every);
      },
      { autorun: false, connection, prefix },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});
    await worker.waitUntilReady();

    let processed = 0;
    const completing = new Promise<void>(resolve => {
      worker.on('completed', async () => {
        processed++;
        if (processed === 10) {
          resolve();
        }
      });
    });

    const job = await queue.upsertJobScheduler('test-scheduler', {
      endDate: Date.now() + 1000,
      every: 100,
    });

    expect(job!.repeatJobKey).to.not.be.undefined;

    this.clock.tick(every + 1);

    worker.run();

    await completing;

    const delayed = await queue.getDelayed();

    expect(delayed).to.have.length(0);
    expect(processed).to.be.equal(10);

    await worker.close();
    delayStub.restore();
  });

  describe('when jobs have the same cron pattern and different job scheduler id', function () {
    it('should create multiple jobs', async function () {
      const cron = '*/10 * * * * *';

      await Promise.all([
        queue.upsertJobScheduler('test-scheduler1', { pattern: cron }),
        queue.upsertJobScheduler('test-scheduler2', { pattern: cron }),
        queue.upsertJobScheduler('test-scheduler3', { pattern: cron }),
      ]);

      const count = await queue.count();
      expect(count).to.be.eql(3);

      const delayed = await queue.getDelayed();
      expect(delayed).to.have.length(3);

      const jobSchedulersCount = await queue.getJobSchedulersCount();
      expect(jobSchedulersCount).to.be.eql(3);
    });
  });

  describe('when job schedulers have same id and different every pattern', function () {
    it('should create only one job scheduler', async function () {
      const date = new Date('2017-02-07 9:24:00');
      this.clock.setSystemTime(date);

      await Promise.all([
        queue.upsertJobScheduler('test-scheduler1', { every: 1000 }),
        queue.upsertJobScheduler('test-scheduler1', { every: 2000 }),
        queue.upsertJobScheduler('test-scheduler1', { every: 3000 }),
      ]);

      const repeatableJobs = await queue.getJobSchedulers();
      expect(repeatableJobs.length).to.be.eql(1);
    });
  });

  describe('when job schedulers are upserted in quick succession', function () {
    it('should create only one job scheduler and one delayed job', async function () {
      const date = new Date('2017-02-07 9:24:00');
      this.clock.setSystemTime(date);
      const worker = new Worker(
        queueName,
        async () => {
          await this.clock.tickAsync(1);
        },
        {
          connection,
          prefix,
          concurrency: 1,
        },
      );
      await worker.waitUntilReady();

      const jobSchedulerId = 'test';
      await queue.upsertJobScheduler(jobSchedulerId, {
        every: ONE_MINUTE * 5,
      });
      await this.clock.tickAsync(1);
      await queue.upsertJobScheduler(jobSchedulerId, {
        every: ONE_MINUTE * 5,
      });

      await queue.upsertJobScheduler(jobSchedulerId, {
        every: ONE_MINUTE * 5,
      });

      await queue.upsertJobScheduler(jobSchedulerId, {
        every: ONE_MINUTE * 5,
      });

      const repeatableJobs = await queue.getJobSchedulers();
      expect(repeatableJobs.length).to.be.eql(1);
      await this.clock.tickAsync(ONE_MINUTE);
      const count = await queue.getJobCountByTypes('delayed', 'waiting');
      expect(count).to.be.equal(1);

      await worker.close();
    });

    it('should create only one job scheduler and one delayed job with different settings', async function () {
      const date = new Date('2017-02-07T09:24:00.000+05:30');
      this.clock.setSystemTime(date);
      const worker = new Worker(queueName, void 0, { connection, prefix });
      await worker.waitUntilReady();

      const jobSchedulerId = 'test';
      await queue.upsertJobScheduler(jobSchedulerId, {
        every: ONE_MINUTE * 1,
      });

      const token = 'my-token';
      (await worker.getNextJob(token)) as Job;

      await this.clock.tickAsync(1);

      await queue.upsertJobScheduler(jobSchedulerId, {
        every: ONE_MINUTE * 2,
      });

      await this.clock.tickAsync(1);

      await queue.upsertJobScheduler(jobSchedulerId, {
        every: ONE_MINUTE * 3,
      });

      await this.clock.tickAsync(1);

      await queue.upsertJobScheduler(jobSchedulerId, {
        every: ONE_MINUTE * 4,
      });

      const repeatableJobs = await queue.getJobSchedulers();
      expect(repeatableJobs.length).to.be.eql(1);

      expect(repeatableJobs[0]).to.deep.equal({
        key: 'test',
        name: 'test',
        next: 1486439520000,
        iterationCount: 1,
        every: 240000,
        offset: 120003,
      });

      await this.clock.tickAsync(ONE_MINUTE);
      const count = await queue.getJobCountByTypes('delayed', 'waiting');
      expect(count).to.be.equal(1);

      await worker.close();
    });

    describe('when next delayed job already exists and it is not in waiting or delayed states', function () {
      it('emits duplicated event and does not update scheduler', async function () {
        const date = new Date('2017-02-07T09:24:00.000+05:30');
        this.clock.setSystemTime(date);
        const worker = new Worker(queueName, void 0, { connection, prefix });
        const token = 'my-token';

        await worker.waitUntilReady();

        const jobSchedulerId = 'test';
        await queue.upsertJobScheduler(jobSchedulerId, {
          every: ONE_MINUTE * 1,
        });

        const duplicating = new Promise<void>(resolve => {
          queueEvents.once('duplicated', () => {
            resolve();
          });
        });

        (await worker.getNextJob(token)) as Job;

        await queue.upsertJobScheduler(jobSchedulerId, {
          every: ONE_MINUTE * 2,
        });

        await duplicating;

        const repeatableJobs = await queue.getJobSchedulers();
        expect(repeatableJobs.length).to.be.eql(1);

        expect(repeatableJobs[0]).to.deep.equal({
          key: 'test',
          name: 'test',
          next: 1486439700000,
          iterationCount: 2,
          every: 60000,
          offset: 0,
        });

        const count = await queue.getJobCountByTypes('delayed');
        expect(count).to.be.equal(1);

        await worker.close();
      });

      describe('when job scheduler is being updated', function () {
        it('emits duplicated event and does not update scheduler', async function () {
          const date = new Date('2017-02-07T09:24:00.000+05:30');
          this.clock.setSystemTime(date);
          const worker = new Worker(
            queueName,
            async job => {
              if (job.data.foo === 'bar') {
                await queue.upsertJobScheduler(
                  jobSchedulerId,
                  {
                    pattern: '*/2 * * * * *',
                  },
                  {
                    data: {
                      foo: 'baz',
                    },
                  },
                );
              }
              this.clock.tick(2000);
            },
            { autorun: false, connection, prefix },
          );

          await worker.waitUntilReady();

          const jobSchedulerId = 'test';
          const delayedJob = await queue.upsertJobScheduler(
            jobSchedulerId,
            {
              pattern: '*/10 * * * * *',
            },
            {
              data: {
                foo: 'bar',
              },
            },
          );

          await delayedJob!.promote();
          worker.run();

          const duplicating = new Promise<void>(resolve => {
            queueEvents.once('duplicated', () => {
              resolve();
            });
          });

          await duplicating;

          const repeatableJobs = await queue.getJobSchedulers();
          expect(repeatableJobs.length).to.be.eql(1);

          expect(repeatableJobs[0]).to.deep.equal({
            key: 'test',
            name: 'test',
            next: 1486439648000,
            iterationCount: 4,
            pattern: '*/2 * * * * *',
            template: {
              data: {
                foo: 'baz',
              },
            },
          });

          const count = await queue.getJobCountByTypes('delayed');
          expect(count).to.be.equal(0);

          await worker.close();
        });
      });
    });

    describe('when generated job is in waiting state', function () {
      it('should upsert scheduler by removing waiting job', async function () {
        const date = new Date('2017-02-07 9:24:00');
        this.clock.setSystemTime(date);

        const jobSchedulerId = 'test';

        await queue.upsertJobScheduler(jobSchedulerId, {
          pattern: '10 * * * * *',
        });
        const delayedJobs = await queue.getDelayed();
        await delayedJobs[0].promote();

        const waitingCount = await queue.getWaitingCount();
        expect(waitingCount).to.be.eql(1);

        await queue.upsertJobScheduler(jobSchedulerId, {
          pattern: '2 10 * * * *',
        });

        const waitingCountAfter = await queue.getWaitingCount();
        expect(waitingCountAfter).to.be.eql(0);

        const delayedCount = await queue.getDelayedCount();
        expect(delayedCount).to.be.eql(1);
      });
    });

    describe('when generated job is in paused state', function () {
      it('should upsert scheduler by removing paused job', async function () {
        const date = new Date('2017-02-07 9:24:00');
        this.clock.setSystemTime(date);

        const jobSchedulerId = 'test';

        await queue.pause();
        await queue.upsertJobScheduler(jobSchedulerId, {
          pattern: '10 * * * * *',
        });
        const delayedJobs = await queue.getDelayed();
        await delayedJobs[0].promote();

        const waitingCount = await queue.getWaitingCount();
        expect(waitingCount).to.be.eql(1);

        await queue.upsertJobScheduler(jobSchedulerId, {
          pattern: '2 10 * * * *',
        });

        const waitingCountAfter = await queue.getWaitingCount();
        expect(waitingCountAfter).to.be.eql(0);

        const delayedCount = await queue.getDelayedCount();
        expect(delayedCount).to.be.eql(1);
      });
    });

    describe('when generated job is in prioritized state', function () {
      it('should upsert scheduler by removing prioritized job', async function () {
        const date = new Date('2017-02-07 9:24:00');
        this.clock.setSystemTime(date);

        const jobSchedulerId = 'test';

        await queue.upsertJobScheduler(
          jobSchedulerId,
          {
            pattern: '10 * * * * *',
          },
          {
            opts: {
              priority: 1,
            },
          },
        );
        const delayedJobs = await queue.getDelayed();
        await delayedJobs[0].promote();

        const prioritizedCount = await queue.getPrioritizedCount();
        expect(prioritizedCount).to.be.eql(1);

        await queue.upsertJobScheduler(jobSchedulerId, {
          pattern: '2 10 * * * *',
        });

        const prioritizedCountAfter = await queue.getPrioritizedCount();
        expect(prioritizedCountAfter).to.be.eql(0);

        const delayedCount = await queue.getDelayedCount();
        expect(delayedCount).to.be.eql(1);
      });
    });
  });

  describe('when clocks are slightly out of sync', function () {
    it('should create only one delayed job', async function () {
      const date = new Date('2017-02-07 9:24:00');
      this.clock.setSystemTime(date);

      const scheduler1 = queue.upsertJobScheduler(
        'test-scheduler1',
        {
          every: 100,
        },
        { opts: { prevMillis: Date.now() } },
      );

      this.clock.tick(1);
      const scheduler2 = queue.upsertJobScheduler(
        'test-scheduler1',
        {
          every: 100,
        },
        { opts: { prevMillis: Date.now() } },
      );

      this.clock.tick(1);
      const scheduler3 = queue.upsertJobScheduler(
        'test-scheduler1',
        {
          every: 100,
        },
        { opts: { prevMillis: Date.now() } },
      );

      await Promise.all([scheduler1, scheduler2, scheduler3]);

      const repeatableJobs = await queue.getJobSchedulers();
      expect(repeatableJobs.length).to.be.eql(1);

      const delayed = await queue.getDelayed();
      expect(delayed).to.have.length(1);
    });
  });

  describe('when job scheduler does not exist', function () {
    it('should return undefined', async function () {
      const scheduler = await queue.getJobScheduler('test');

      expect(scheduler).to.be.undefined;
    });
  });

  it('should create job schedulers with different cron patterns', async function () {
    const date = new Date('2017-02-07T15:24:00.000Z');
    this.clock.setSystemTime(date);

    const crons = [
      '10 * * * * *',
      '2 10 * * * *',
      '1 * * 5 * *',
      '2 * * 4 * *',
    ];

    await Promise.all([
      queue.upsertJobScheduler('first', {
        pattern: crons[0],
        endDate: Date.now() + 12345,
      }),
      queue.upsertJobScheduler('second', {
        pattern: crons[1],
        endDate: Date.now() + 6100000,
      }),
      queue.upsertJobScheduler('third', {
        pattern: crons[2],
        tz: 'Africa/Abidjan',
      }),
      queue.upsertJobScheduler('fourth', {
        pattern: crons[3],
        tz: 'Africa/Accra',
      }),
      queue.upsertJobScheduler('fifth', {
        every: 5000,
        tz: 'Europa/Copenhaguen',
      }),
    ]);

    const count = await repeat.getRepeatableCount();
    expect(count).to.be.eql(5);

    const delayedCount = await queue.getDelayedCount();
    expect(delayedCount).to.be.eql(4);

    const waitingCount = await queue.getWaitingCount();
    expect(waitingCount).to.be.eql(1);

    const jobs = await repeat.getRepeatableJobs(0, -1, true);

    expect(jobs)
      .to.be.and.an('array')
      .and.have.length(5)
      .and.to.deep.include({
        key: 'fifth',
        name: 'fifth',
        endDate: null,
        tz: 'Europa/Copenhaguen',
        pattern: null,
        every: '5000',
        next: 1486481040000,
      })
      .and.to.deep.include({
        key: 'first',
        name: 'first',
        endDate: Date.now() + 12345,
        tz: null,
        pattern: '10 * * * * *',
        every: null,
        next: 1486481050000,
      })
      .and.to.deep.include({
        key: 'second',
        name: 'second',
        endDate: Date.now() + 6100000,
        tz: null,
        pattern: '2 10 * * * *',
        every: null,
        next: 1486483802000,
      })
      .and.to.deep.include({
        key: 'fourth',
        name: 'fourth',
        endDate: null,
        tz: 'Africa/Accra',
        pattern: '2 * * 4 * *',
        every: null,
        next: 1488585602000,
      })
      .and.to.deep.include({
        key: 'third',
        name: 'third',
        endDate: null,
        tz: 'Africa/Abidjan',
        pattern: '1 * * 5 * *',
        every: null,
        next: 1488672001000,
      });
  });

  it('should repeat every 2 seconds', async function () {
    this.timeout(10000);

    const nextTick = 2 * ONE_SECOND + 100;

    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(nextTick);
      },
      { autorun: false, connection, prefix },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    const date = new Date('2017-02-07T15:24:00.000Z');
    this.clock.setSystemTime(date);

    await queue.upsertJobScheduler(
      'test',
      { pattern: '*/2 * * * * *' },
      { data: { foo: 'bar' } },
    );

    const scheduler = await queue.getJobScheduler('test');

    expect(scheduler).to.deep.equal({
      iterationCount: 1,
      key: 'test',
      name: 'test',
      pattern: '*/2 * * * * *',
      next: 1486481042000,
      template: {
        data: {
          foo: 'bar',
        },
      },
    });

    this.clock.tick(nextTick);

    let prev: any;
    let counter = 0;

    const completing = new Promise<void>(resolve => {
      worker.on('completed', async job => {
        if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(2000);
        }
        prev = job;
        counter++;
        if (counter == 5) {
          resolve();
        }
      });
    });

    worker.run();

    await completing;
    await worker.close();
    delayStub.restore();
  });

  it('should repeat every 2 seconds with startDate in future', async function () {
    this.timeout(10000);

    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);
    const nextTick = 2 * ONE_SECOND + 500;
    const delay = 5 * ONE_SECOND + 500;

    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(nextTick);
      },
      { autorun: false, connection, prefix },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    await queue.upsertJobScheduler(
      'test',
      {
        pattern: '*/2 * * * * *',
        startDate: new Date('2017-02-07 9:24:05'),
      },
      { data: { foo: 'bar' } },
    );

    this.clock.tick(nextTick + delay);

    let prev: Job;
    let counter = 0;

    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', async job => {
        if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(2000);
        }
        prev = job;
        counter++;
        if (counter == 5) {
          resolve();
        }
      });
    });

    worker.run();

    await completing;

    await worker.close();
    delayStub.restore();
  });

  it('should repeat every 2 seconds with startDate in past', async function () {
    this.timeout(10000);

    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);
    const nextTick = 2 * ONE_SECOND + 500;
    const delay = 5 * ONE_SECOND + 500;

    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(nextTick);
      },
      { autorun: false, connection, prefix },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    await queue.upsertJobScheduler(
      'repeat',
      {
        pattern: '*/2 * * * * *',
        startDate: new Date('2017-02-07 9:22:00'),
      },
      { data: { foo: 'bar' } },
    );

    this.clock.tick(nextTick + delay);

    let prev: Job;
    let counter = 0;

    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', async job => {
        if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(2000);
        }
        prev = job;
        counter++;
        if (counter == 5) {
          resolve();
        }
      });
    });

    worker.run();

    await completing;
    await worker.close();
    delayStub.restore();
  });

  describe('when using removeOnComplete', function () {
    it('should remove repeated job', async function () {
      this.timeout(10000);
      const queueName2 = `test-${v4()}`;
      const queue2 = new Queue(queueName2, {
        connection,
        prefix,
        defaultJobOptions: {
          removeOnComplete: true,
        },
      });

      const date = new Date('2017-02-07 9:24:00');
      this.clock.setSystemTime(date);
      const nextTick = 2 * ONE_SECOND + 500;
      const delay = 5 * ONE_SECOND + 500;

      const worker = new Worker(
        queueName2,
        async () => {
          this.clock.tick(nextTick);
        },
        { autorun: false, connection, prefix },
      );
      const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

      await queue2.upsertJobScheduler(
        'test',
        {
          pattern: '*/2 * * * * *',
          startDate: new Date('2017-02-07 9:24:05'),
        },
        { data: { foo: 'bar' } },
      );

      this.clock.tick(nextTick + delay);

      let prev: Job;
      let counter = 0;

      const completing = new Promise<void>((resolve, reject) => {
        worker.on('completed', async job => {
          if (prev) {
            expect(prev.timestamp).to.be.lt(job.timestamp);
            expect(job.timestamp - prev.timestamp).to.be.gte(2000);
          }
          prev = job;
          counter++;
          if (counter == 5) {
            const counts = await queue2.getJobCounts('completed');
            expect(counts.completed).to.be.equal(0);
            resolve();
          }
        });
      });

      worker.run();

      await completing;

      await queue2.close();
      await worker.close();
      await removeAllQueueData(new IORedis(redisHost), queueName2);
      delayStub.restore();
    });
  });

  describe('when custom cron strategy is provided', function () {
    it('should repeat every 2 seconds', async function () {
      this.timeout(15000);
      const settings = {
        repeatStrategy: (millis, opts) => {
          const currentDate =
            opts.startDate && new Date(opts.startDate) > new Date(millis)
              ? new Date(opts.startDate)
              : new Date(millis);
          const rrule = rrulestr(opts.pattern);
          if (rrule.origOptions.count && !rrule.origOptions.dtstart) {
            throw new Error('DTSTART must be defined to use COUNT with rrule');
          }

          const next_occurrence = rrule.after(currentDate, false);
          return next_occurrence?.getTime();
        },
      };
      const currentQueue = new Queue(queueName, {
        connection,
        prefix,
        settings,
      });

      const nextTick = 2 * ONE_SECOND + 100;

      const worker = new Worker(
        queueName,
        async () => {
          this.clock.tick(nextTick);
        },
        { connection, prefix, settings },
      );
      const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

      const date = new Date('2017-02-07 9:24:00');
      this.clock.setSystemTime(date);

      await currentQueue.upsertJobScheduler(
        'test',
        {
          pattern: 'RRULE:FREQ=SECONDLY;INTERVAL=2;WKST=MO',
        },
        { data: { foo: 'bar' } },
      );

      this.clock.tick(nextTick);

      let prev: any;
      let counter = 0;

      const completing = new Promise<void>(resolve => {
        worker.on('completed', async job => {
          if (prev) {
            expect(prev.timestamp).to.be.lt(job.timestamp);
            expect(job.timestamp - prev.timestamp).to.be.gte(2000);
          }
          prev = job;
          counter++;
          if (counter == 5) {
            resolve();
          }
        });
      });

      await completing;
      await currentQueue.close();
      await worker.close();
      delayStub.restore();
    });

    describe('when differentiating strategy by job name', function () {
      it('should repeat every 2 seconds', async function () {
        this.timeout(10000);
        const settings = {
          repeatStrategy: (millis, opts, name) => {
            if (name === 'rrule') {
              const currentDate =
                opts.startDate && new Date(opts.startDate) > new Date(millis)
                  ? new Date(opts.startDate)
                  : new Date(millis);
              const rrule = rrulestr(opts.pattern);
              if (rrule.origOptions.count && !rrule.origOptions.dtstart) {
                throw new Error(
                  'DTSTART must be defined to use COUNT with rrule',
                );
              }

              const next_occurrence = rrule.after(currentDate, false);
              return next_occurrence?.getTime();
            } else {
              return getNextMillis(millis, opts);
            }
          },
        };
        const currentQueue = new Queue(queueName, {
          connection,
          prefix,
          settings,
        });

        const nextTick = 2 * ONE_SECOND + 100;

        const worker = new Worker(
          queueName,
          async job => {
            this.clock.tick(nextTick);

            if (job.opts.repeat!.count == 5) {
              const removed = await queue.removeJobScheduler('rrule');
              expect(removed).to.be.true;
            }
          },
          { connection, prefix, settings },
        );
        const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

        const date = new Date('2017-02-07T15:24:00.000Z');
        this.clock.setSystemTime(date);

        const repeat = {
          pattern: 'RRULE:FREQ=SECONDLY;INTERVAL=2;WKST=MO',
        };
        await currentQueue.upsertJobScheduler('rrule', repeat, {
          name: 'rrule',
        });

        const scheduler = await queue.getJobScheduler('rrule');

        expect(scheduler).to.deep.equal({
          iterationCount: 1,
          key: 'rrule',
          name: 'rrule',
          next: 1486481042000,
          pattern: 'RRULE:FREQ=SECONDLY;INTERVAL=2;WKST=MO',
        });

        this.clock.tick(nextTick);

        let prev: any;
        let counter = 0;

        const completing = new Promise<void>((resolve, reject) => {
          worker.on('completed', async job => {
            try {
              if (prev) {
                expect(prev.timestamp).to.be.lt(job.timestamp);
                expect(job.timestamp - prev.timestamp).to.be.gte(2000);
              }
              prev = job;
              counter++;
              if (counter == 5) {
                resolve();
              }
            } catch (error) {
              reject(error);
            }
          });
        });

        await completing;

        let prev2: any;
        let counter2 = 0;

        const completing2 = new Promise<void>((resolve, reject) => {
          worker.on('completed', async job => {
            try {
              if (prev2) {
                expect(prev2.timestamp).to.be.lt(job.timestamp);
                expect(job.timestamp - prev2.timestamp).to.be.gte(2000);
              }
              prev2 = job;
              counter2++;
              if (counter2 == 5) {
                resolve();
              }
            } catch (error) {
              reject(error);
            }
          });
        });

        await queue.upsertJobScheduler(
          'rrule',
          {
            pattern: '*/2 * * * * *',
            startDate: new Date('2017-02-07 9:24:05'),
          },
          {
            name: 'standard',
          },
        );

        this.clock.tick(nextTick);

        await completing2;

        await currentQueue.close();
        await worker.close();
        delayStub.restore();
      });
    });
  });

  describe("when using 'every' option is on same millis as iteration time", function () {
    it('should repeat every 2 seconds and start immediately', async function () {
      const date = new Date('2017-02-07 9:24:00');
      this.clock.setSystemTime(date);
      const nextTick = 2 * ONE_SECOND;

      let iterationCount = 0;
      const worker = new Worker(
        queueName,
        async job => {
          if (iterationCount === 0) {
            expect(job.opts.delay).to.be.eq(0);
          } else {
            expect(job.opts.delay).to.be.eq(2000);
          }
          iterationCount++;
          this.clock.tick(nextTick);
        },
        { autorun: false, connection, prefix },
      );

      let prev: Job;
      let counter = 0;

      const completing = new Promise<void>((resolve, reject) => {
        worker.on('completed', async job => {
          try {
            if (prev && counter === 1) {
              expect(prev.timestamp).to.be.lte(job.timestamp);
              expect(job.timestamp - prev.timestamp).to.be.lte(1);
            } else if (prev) {
              expect(prev.timestamp).to.be.lt(job.timestamp);
              expect(job.timestamp - prev.timestamp).to.be.eq(2000);
            }
            prev = job;
            counter++;
            if (counter === 5) {
              resolve();
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      await queue.upsertJobScheduler(
        'repeat',
        {
          every: 2000,
        },
        { data: { foo: 'bar' } },
      );

      const waitingCountBefore = await queue.getWaitingCount();
      expect(waitingCountBefore).to.be.eq(1);

      worker.run();

      await completing;

      const waitingCount = await queue.getWaitingCount();
      expect(waitingCount).to.be.eq(0);

      const delayedCountAfter = await queue.getDelayedCount();
      expect(delayedCountAfter).to.be.eq(1);

      await worker.close();
    });
  });

  describe("when using 'every' and time is one millisecond before iteration time", function () {
    it('should repeat every 2 seconds and start immediately', async function () {
      const startTimeMillis = new Date('2017-02-07 9:24:00').getTime();

      const date = new Date(startTimeMillis - 1);
      this.clock.setSystemTime(date);
      const nextTick = 2 * ONE_SECOND;

      const worker = new Worker(
        queueName,
        async () => {
          this.clock.tick(nextTick);
        },
        { connection, prefix },
      );

      let prev: Job;
      let counter = 0;

      const completing = new Promise<void>((resolve, reject) => {
        worker.on('completed', async job => {
          try {
            if (prev && counter === 1) {
              expect(prev.timestamp).to.be.lte(job.timestamp);
              expect(job.timestamp - prev.timestamp).to.be.lte(1);
            } else if (prev) {
              expect(prev.timestamp).to.be.lt(job.timestamp);
              expect(job.timestamp - prev.timestamp).to.be.eq(2000);
            }

            prev = job;
            counter++;
            if (counter === 5) {
              resolve();
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      await queue.upsertJobScheduler(
        'repeat',
        {
          every: 2000,
        },
        { data: { foo: 'bar' } },
      );

      await completing;

      await worker.close();
    });
  });

  describe("when using 'every' and time is one millisecond after iteration time", function () {
    it('should repeat every 2 seconds and start immediately', async function () {
      const startTimeMillis = new Date('2017-02-07 9:24:00').getTime() + 1;

      const date = new Date(startTimeMillis);
      this.clock.setSystemTime(date);
      const nextTick = 2 * ONE_SECOND;

      const worker = new Worker(
        queueName,
        async () => {
          this.clock.tick(nextTick);
        },
        { connection, prefix },
      );

      let prev: Job;
      let counter = 0;

      const completing = new Promise<void>((resolve, reject) => {
        worker.on('completed', async job => {
          try {
            if (prev && counter === 1) {
              expect(prev.timestamp).to.be.lte(job.timestamp);
              expect(job.timestamp - prev.timestamp).to.be.lte(1);
            } else if (prev) {
              expect(prev.timestamp).to.be.lt(job.timestamp);
              expect(job.timestamp - prev.timestamp).to.be.eq(2000);
            }

            prev = job;
            counter++;
            if (counter === 5) {
              resolve();
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      await queue.upsertJobScheduler(
        'repeat',
        {
          every: 2000,
        },
        { data: { foo: 'bar' } },
      );

      await completing;

      await worker.close();
    });
  });

  it('should start immediately even after removing the job scheduler and adding it again', async function () {
    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);
    const nextTick = 2 * ONE_SECOND;

    let worker: Worker;
    const processing1 = new Promise<void>((resolve, reject) => {
      worker = new Worker(
        queueName,
        async (job: Job) => {
          this.clock.tick(nextTick);

          try {
            expect(job.opts.delay).to.be.eq(0);
            resolve();
          } catch (error) {
            reject(error);
          }
        },
        { connection, prefix },
      );
    });

    await queue.upsertJobScheduler(
      'repeat',
      {
        every: 2000,
      },
      { data: { foo: 'bar' } },
    );

    this.clock.tick(nextTick);

    await processing1;

    await worker!.close();

    await queue.removeJobScheduler('repeat');

    const processing2 = new Promise<void>((resolve, reject) => {
      worker = new Worker(
        queueName,
        async (job: Job) => {
          this.clock.tick(nextTick);

          try {
            expect(job.opts.delay).to.be.eq(0);
            resolve();
          } catch (error) {
            reject(error);
          }
        },
        { connection, prefix },
      );
    });

    await queue.upsertJobScheduler(
      'repeat',
      {
        every: 2000,
      },
      { data: { foo: 'bar' } },
    );

    await processing2;

    await worker!.close();
  });

  it('should repeat once a day for 5 days and start immediately using endDate', async function () {
    this.timeout(8000);

    const date = new Date('2017-05-05 01:01:00');
    this.clock.setSystemTime(date);

    const nextTick = ONE_DAY + 10 * ONE_SECOND;
    const delay = 5 * ONE_SECOND + 500;

    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(nextTick);
      },
      {
        autorun: false,
        connection,
        prefix,
        skipStalledCheck: true,
        skipLockRenewal: true,
      },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {
      console.log('delay');
    });

    let prev: Job;
    let counter = 0;
    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', async job => {
        if (counter === 1) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(delay);
        } else if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.timestamp - prev.timestamp).to.be.gte(ONE_DAY);
        }
        prev = job;

        counter++;
        if (counter == 5) {
          resolve();
        }
      });
    });

    await queue.upsertJobScheduler(
      'repeat',
      {
        pattern: '0 1 * * *',
        immediately: true,
        endDate: new Date('2017-05-10 13:13:00'),
      },
      { data: { foo: 'bar' } },
    );
    this.clock.tick(delay);

    worker.run();

    await completing;
    await worker.close();
    delayStub.restore();
  });

  it('should repeat once a day for 5 days and start immediately', async function () {
    this.timeout(8000);

    const date = new Date('2017-05-05 01:01:00');
    this.clock.setSystemTime(date);

    const nextTick = ONE_DAY + 10 * ONE_SECOND;
    const delay = 5 * ONE_SECOND + 500;

    let counter = 0;
    const worker = new Worker(
      queueName,
      async () => {
        if (counter === 0) {
          this.clock.tick(6 * ONE_HOUR);
        } else {
          this.clock.tick(nextTick);
        }
      },
      {
        autorun: false,
        connection,
        prefix,
        skipStalledCheck: true,
        skipLockRenewal: true,
      },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {
      console.log('delay');
    });

    let prev: Job;
    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', async job => {
        if (counter === 1) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.processedOn! - prev.timestamp).to.be.gte(delay);
        } else if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.processedOn! - prev.timestamp).to.be.gte(ONE_DAY);
        }
        prev = job;

        counter++;
        if (counter == 5) {
          resolve();
        }
      });
    });

    await queue.upsertJobScheduler(
      'repeat',
      {
        pattern: '0 0 7 * * *',
        immediately: true,
      },
      { data: { foo: 'bar' } },
    );
    this.clock.tick(delay);

    worker.run();

    await completing;
    await worker.close();
    delayStub.restore();
  });

  it('should repeat once a day after startDate that is equal as first iteration', async function () {
    this.timeout(8000);

    const date = new Date('2024-10-10T16:30:00.000+05:30');
    this.clock.setSystemTime(date);

    const nextTick = ONE_DAY + 10 * ONE_SECOND;
    const delay = 5 * ONE_HOUR + 500;

    let counter = 0;
    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(nextTick);
      },
      {
        autorun: false,
        connection,
        prefix,
        skipStalledCheck: true,
        skipLockRenewal: true,
      },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {
      console.log('delay');
    });

    let prev: Job;
    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', async job => {
        if (counter === 1) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.processedOn! - prev.timestamp).to.be.gte(delay);
        } else if (prev) {
          expect(prev.timestamp).to.be.lt(job.timestamp);
          expect(job.processedOn! - prev.timestamp).to.be.gte(ONE_DAY);
        }
        prev = job;

        counter++;
        if (counter == 5) {
          resolve();
        }
      });
    });

    await queue.upsertJobScheduler(
      'repeat',
      {
        pattern: '30 19 * * *',
        startDate: '2024-10-10T19:30:00.000+05:30',
        tz: 'Asia/Calcutta',
      },
      { data: { foo: 'bar' } },
    );
    this.clock.tick(delay + ONE_DAY);

    worker.run();

    await completing;
    await worker.close();
    delayStub.restore();
  });

  it('should repeat once a day for 5 days', async function () {
    this.timeout(8000);

    const date = new Date('2017-05-05 13:12:00');
    this.clock.setSystemTime(date);

    const nextTick = ONE_DAY + 10 * ONE_SECOND;
    const delay = 5 * ONE_SECOND + 500;

    const worker = new Worker(
      queueName,
      async () => {
        this.clock.tick(nextTick);
      },
      {
        autorun: false,
        connection,
        prefix,
        skipStalledCheck: true,
        skipLockRenewal: true,
      },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {
      console.log('delay');
    });

    let prev: Job;
    let counter = 0;
    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', async job => {
        try {
          if (prev) {
            expect(prev.timestamp).to.be.lt(job.timestamp);
            expect(job.timestamp - prev.timestamp).to.be.gte(ONE_DAY);
          }
          prev = job;

          counter++;
          if (counter == 5) {
            resolve();
          }
        } catch (error) {
          console.log(error);
          reject(error);
        }
      });
    });

    await queue.upsertJobScheduler(
      'repeat',
      {
        pattern: '0 1 * * *',
        endDate: new Date('2017-05-10 01:00:00'),
      },
      { data: { foo: 'bar' } },
    );

    this.clock.tick(nextTick + delay);

    worker.run();

    await completing;
    await worker.close();
    delayStub.restore();
  });

  describe('when utc option is provided', function () {
    it('repeats once a day for 5 days', async function () {
      this.timeout(8000);

      const date = new Date('2017-05-05 13:12:00');
      this.clock.setSystemTime(date);

      const nextTick = ONE_DAY + 10 * ONE_SECOND;
      const delay = 5 * ONE_SECOND + 500;

      const worker = new Worker(
        queueName,
        async () => {
          this.clock.tick(nextTick);
        },
        { autorun: false, connection, prefix },
      );
      const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {
        console.log('delay');
      });

      let prev: Job;
      let counter = 0;
      const completing = new Promise<void>((resolve, reject) => {
        worker.on('completed', async job => {
          try {
            if (prev) {
              expect(prev.timestamp).to.be.lt(job.timestamp);
              expect(job.timestamp - prev.timestamp).to.be.gte(ONE_DAY);
            }
            prev = job;

            counter++;
            if (counter == 5) {
              resolve();
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      const job = await queue.upsertJobScheduler('repeat', {
        pattern: '0 1 * * *',
        endDate: new Date('2017-05-10 13:13:00'),
        tz: 'Europe/Athens',
        utc: true,
      });

      expect(job).to.be.ok;

      this.clock.tick(nextTick + delay);

      worker.run();

      await completing;
      await worker.close();
      delayStub.restore();
    });
  });

  it('should repeat 7:th day every month at 9:25', async function () {
    this.timeout(12000);

    const date = new Date('2017-02-02 7:21:42');
    this.clock.setSystemTime(date);

    const nextTick = () => {
      const now = moment();
      const nextMonth = moment().add(1, 'months');
      this.clock.tick(nextMonth - now);
    };

    const worker = new Worker(
      queueName,
      async () => {
        nextTick();
      },
      { autorun: false, connection, prefix },
    );
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    let counter = 25;
    let prev: Job;
    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', async job => {
        try {
          if (prev) {
            expect(prev.timestamp).to.be.lt(job.timestamp);
            const diff = moment(job.processedOn!).diff(
              moment(prev.timestamp),
              'months',
              true,
            );
            expect(diff).to.be.gte(1);
          }
          prev = job;

          counter--;
          if (counter == 0) {
            resolve();
          }
        } catch (error) {
          console.log(error);
          reject(error);
        }
      });
    });

    worker.run();

    await queue.upsertJobScheduler('repeat', { pattern: '25 9 7 * *' });
    nextTick();

    await completing;
    await worker.close();
    delayStub.restore();
  });

  describe('when 2 jobs with the same options are added', function () {
    it('creates only one job', async function () {
      const repeatOpts = {
        pattern: '0 1 * * *',
      };

      const p1 = queue.upsertJobScheduler('test', repeatOpts);
      const p2 = queue.upsertJobScheduler('test', repeatOpts);

      const jobs = await Promise.all([p1, p2]);
      const configs = await repeat.getRepeatableJobs(0, -1, true);

      const count = await queue.count();

      expect(count).to.be.equal(1);
      expect(configs).to.have.length(1);
      expect(jobs.length).to.be.eql(2);
      expect(jobs[0]!.id).to.be.eql(jobs[1]!.id);
    });
  });

  describe('when repeatable job is promoted', function () {
    it('keeps one repeatable and one delayed after being processed', async function () {
      const repeatOpts = {
        pattern: '0 * 1 * *',
      };

      const worker = new Worker(queueName, async () => {}, {
        connection,
        prefix,
      });

      const completing = new Promise<void>(resolve => {
        worker.on('completed', () => {
          resolve();
        });
      });

      const repeatableJob = await queue.upsertJobScheduler('test', repeatOpts);
      const delayedCount = await queue.getDelayedCount();
      expect(delayedCount).to.be.equal(1);

      await repeatableJob!.promote();
      await completing;

      const delayedCount2 = await queue.getDelayedCount();
      expect(delayedCount2).to.be.equal(1);

      const configs = await repeat.getRepeatableJobs(0, -1, true);

      expect(delayedCount).to.be.equal(1);

      const count = await queue.count();

      expect(count).to.be.equal(1);
      expect(configs).to.have.length(1);
      await worker.close();
    });
  });

  it('should allow removing a named repeatable job', async function () {
    const numJobs = 3;
    const date = new Date('2017-02-07 9:24:00');
    let prev: Job;
    let counter = 0;

    this.clock.setSystemTime(date);

    const nextTick = ONE_SECOND + 1;
    let processor;

    const processing = new Promise<void>((resolve, reject) => {
      processor = async () => {
        counter++;
        try {
          if (counter == numJobs) {
            const removed = await queue.removeJobScheduler('remove');
            //expect(removed).to.be.true;
            this.clock.tick(nextTick);
            //const delayed = await queue.getDelayed();
            //expect(delayed).to.be.empty;
            resolve();
          } else if (counter > numJobs) {
            reject(Error(`should not repeat more than ${numJobs} times`));
          }
        } catch (err) {
          reject(err);
        }
      };
    });

    const worker = new Worker(queueName, processor, { connection, prefix });
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    await queue.upsertJobScheduler('remove', { pattern: '*/1 * * * * *' });
    this.clock.tick(nextTick);

    worker.on('completed', job => {
      this.clock.tick(nextTick);
      if (prev) {
        expect(prev.timestamp).to.be.lt(job.timestamp);
        expect(job.timestamp - prev.timestamp).to.be.gte(ONE_SECOND);
      }
      prev = job;
    });

    await processing;
    await worker.close();
    delayStub.restore();
  });

  it('should be able to remove repeatable jobs by key', async () => {
    const client = await queue.client;
    const repeat = { pattern: '*/2 * * * * *' };

    const createdJob = await queue.upsertJobScheduler('remove', repeat);
    const delayedCount1 = await queue.getJobCountByTypes('delayed');
    expect(delayedCount1).to.be.equal(1);
    const job = await queue.getJob(createdJob!.id!);
    const repeatableJobs = await queue.getRepeatableJobs();
    expect(repeatableJobs).to.have.length(1);
    const existBeforeRemoval = await client.exists(
      `${prefix}:${queue.name}:repeat:${createdJob!.repeatJobKey!}`,
    );
    expect(existBeforeRemoval).to.be.equal(1);
    const removed = await queue.removeRepeatableByKey(
      createdJob!.repeatJobKey!,
    );
    const delayedCount = await queue.getJobCountByTypes('delayed');
    expect(delayedCount).to.be.equal(0);
    const existAfterRemoval = await client.exists(
      `${prefix}:${queue.name}:repeat:${createdJob!.repeatJobKey!}`,
    );
    expect(existAfterRemoval).to.be.equal(0);
    expect(job!.repeatJobKey).to.not.be.undefined;
    expect(removed).to.be.true;
    const repeatableJobsAfterRemove = await queue.getRepeatableJobs();
    expect(repeatableJobsAfterRemove).to.have.length(0);
  });

  describe('when repeatable job does not exist', function () {
    it('returns false', async () => {
      const repeat = { pattern: '*/2 * * * * *' };

      await queue.upsertJobScheduler('remove', repeat);
      const repeatableJobs = await queue.getJobSchedulers();
      expect(repeatableJobs).to.have.length(1);
      const removed = await queue.removeJobScheduler(repeatableJobs[0].key);
      expect(removed).to.be.true;
      const removed2 = await queue.removeJobScheduler(repeatableJobs[0].key);
      expect(removed2).to.be.false;
    });
  });

  describe('when repeatable job fails', function () {
    it('should continue repeating', async function () {
      const date = new Date('2017-02-07T15:24:00.000Z');
      this.clock.setSystemTime(date);
      const repeatOpts = {
        pattern: '0 * 1 * *',
        tz: 'Asia/Calcutta',
      };

      const worker = new Worker(
        queueName,
        async () => {
          throw new Error('failed');
        },
        {
          autorun: false,
          connection,
          prefix,
        },
      );

      const failing = new Promise<void>(resolve => {
        worker.on('failed', () => {
          resolve();
        });
      });

      const repeatableJob = await queue.upsertJobScheduler('test', repeatOpts, {
        name: 'a',
        data: { foo: 'bar' },
        opts: { priority: 1 },
      });
      const delayedCount = await queue.getDelayedCount();
      expect(delayedCount).to.be.equal(1);

      await repeatableJob!.promote();

      const priorityCount = await queue.getPrioritizedCount();
      expect(priorityCount).to.be.equal(1);

      worker.run();

      await failing;

      const failedCount = await queue.getFailedCount();
      expect(failedCount).to.be.equal(1);

      const delayedCount2 = await queue.getDelayedCount();
      expect(delayedCount2).to.be.equal(1);

      const jobSchedulers = await queue.getJobSchedulers();

      const count = await queue.count();
      expect(count).to.be.equal(1);
      expect(jobSchedulers).to.have.length(1);

      expect(jobSchedulers[0]).to.deep.equal({
        iterationCount: 2,
        key: 'test',
        name: 'a',
        tz: 'Asia/Calcutta',
        pattern: '0 * 1 * *',
        next: 1488310200000,
        template: {
          data: {
            foo: 'bar',
          },
          opts: {
            priority: 1,
          },
        },
      });

      await worker.close();
    });

    it('should not create a new delayed job if the failed job is retried with retryJobs', async function () {
      const date = new Date('2017-02-07 9:24:00');
      this.clock.setSystemTime(date);

      const repeatOpts = {
        every: 579,
      };

      let isFirstRun = true;

      let worker;
      const processingAfterFailing = new Promise<void>(resolve => {
        worker = new Worker(
          queueName,
          async () => {
            this.clock.tick(177);
            if (isFirstRun) {
              isFirstRun = false;
              throw new Error('failed');
            }
            resolve();
          },
          {
            autorun: false,
            connection,
            prefix,
          },
        );
      });

      const failing = new Promise<void>(resolve => {
        worker.on('failed', async () => {
          resolve();
        });
      });

      await queue.upsertJobScheduler('test', repeatOpts);

      const delayedCountBeforeFailing = await queue.getDelayedCount();
      expect(delayedCountBeforeFailing).to.be.equal(0);

      worker.run();

      await failing;

      const failedCount = await queue.getFailedCount();
      expect(failedCount).to.be.equal(1);

      const delayedCountAfterFailing = await queue.getDelayedCount();
      expect(delayedCountAfterFailing).to.be.equal(1);

      // Retry the failed job
      this.clock.tick(1143);
      await queue.retryJobs({ state: 'failed' });
      const failedCountAfterRetry = await queue.getFailedCount();
      expect(failedCountAfterRetry).to.be.equal(0);

      await processingAfterFailing;

      const failedCountAfterProcessing = await queue.getFailedCount();
      expect(failedCountAfterProcessing).to.be.equal(0);

      await worker.close();

      const waitingCount = await queue.getWaitingCount();
      const delayedCount2 = await queue.getDelayedCount();

      // Due to asynchronicities, the next job could be already in waiting state
      // We just check that both are 1, as it should only exist 1 job in either waiting or delayed state
      expect(waitingCount + delayedCount2).to.be.equal(1);
    });

    it('should not create a new delayed job if the failed job is retried with Job.retry()', async function () {
      let expectError;

      const date = new Date('2017-02-07 9:24:00');
      this.clock.setSystemTime(date);

      const repeatOpts = {
        every: 477,
      };

      let isFirstRun = true;

      const worker = new Worker(
        queueName,
        async () => {
          this.clock.tick(177);

          try {
            const delayedCount = await queue.getDelayedCount();
            expect(delayedCount).to.be.equal(1);
          } catch (error) {
            expectError = error;
          }

          if (isFirstRun) {
            isFirstRun = false;
            throw new Error('failed');
          }
        },
        {
          autorun: false,
          connection,
          prefix,
        },
      );

      const failing = new Promise<void>(resolve => {
        worker.on('failed', async () => {
          resolve();
        });
      });

      await queue.upsertJobScheduler('test', repeatOpts);

      const delayedCount = await queue.getDelayedCount();
      expect(delayedCount).to.be.equal(0);

      this.clock.tick(177);

      worker.run();

      await failing;

      this.clock.tick(177);

      const failedJobs = await queue.getFailed();
      expect(failedJobs.length).to.be.equal(1);

      // Retry the failed job
      const failedJob = await queue.getJob(failedJobs[0].id);
      await failedJob!.retry();
      const failedCountAfterRetry = await queue.getFailedCount();
      expect(failedCountAfterRetry).to.be.equal(0);

      this.clock.tick(177);

      await worker.close();

      if (expectError) {
        throw expectError;
      }

      const delayedCount2 = await queue.getDelayedCount();
      expect(delayedCount2).to.be.equal(1);
    });

    it('should not create a new delayed job if the failed job is stalled and moved back to wait', async function () {
      // Note, this test is expected to throw an exception like this:
      // "Error: Missing lock for job repeat:test:1486455840000. moveToFinished"
      const date = new Date('2017-02-07 9:24:00');
      this.clock.setSystemTime(date);

      const repeatOpts = {
        every: 2000,
      };

      const repeatableJob = await queue.upsertJobScheduler('test', repeatOpts);
      expect(repeatableJob).to.be.ok;

      const waitingCount = await queue.getWaitingCount();
      expect(waitingCount).to.be.equal(1);

      let resolveCompleting: () => void;
      const completingJob = new Promise<void>(resolve => {
        resolveCompleting = resolve;
      });

      let worker: Worker;
      const processing = new Promise<void>(resolve => {
        worker = new Worker(
          queueName,
          async () => {
            resolve();
            return completingJob;
          },
          {
            connection,
            prefix,
            skipLockRenewal: true,
            skipStalledCheck: true,
          },
        );
      });

      await processing;

      // force remove the lock
      const client = await queue.client;
      const lockKey = `${prefix}:${queueName}:${repeatableJob!.id}:lock`;
      await client.del(lockKey);

      const stalledCheckerKey = `${prefix}:${queueName}:stalled-check`;
      await client.del(stalledCheckerKey);

      const scripts = (<any>worker!).scripts;
      let [failed, stalled] = await scripts.moveStalledJobsToWait();

      await client.del(stalledCheckerKey);

      [failed, stalled] = await scripts.moveStalledJobsToWait();

      const waitingJobs = await queue.getWaiting();
      expect(waitingJobs.length).to.be.equal(1);

      await this.clock.tick(500);

      resolveCompleting!();
      await worker!.close();

      await this.clock.tick(500);

      const delayedCount2 = await queue.getDelayedCount();
      expect(delayedCount2).to.be.equal(1);

      let completedJobs = await queue.getCompleted();
      expect(completedJobs.length).to.be.equal(0);

      const processing2 = new Promise<void>(resolve => {
        worker = new Worker(
          queueName,
          async () => {
            resolve();
          },
          {
            connection,
            prefix,
            skipLockRenewal: true,
            skipStalledCheck: true,
          },
        );
      });

      await processing2;

      await worker!.close();

      completedJobs = await queue.getCompleted();
      expect(completedJobs.length).to.be.equal(1);

      const waitingJobs2 = await queue.getWaiting();
      expect(waitingJobs2.length).to.be.equal(0);

      const delayedCount3 = await queue.getDelayedCount();
      expect(delayedCount3).to.be.equal(1);
    });
  });

  describe('when every option is provided', function () {
    it('should keep only one waiting job if adding a new repeatable job with the same id', async function () {
      const date = new Date('2017-02-07 9:24:00');
      const key = 'mykey';

      this.clock.setSystemTime(date);

      const nextTick = 2 * ONE_SECOND;

      await queue.upsertJobScheduler(key, {
        every: 10_000,
      });

      this.clock.tick(nextTick);

      let jobs = await queue.getJobSchedulers();
      expect(jobs).to.have.length(1);

      let waitingJobs = await queue.getWaiting();
      expect(waitingJobs).to.have.length(1);

      await queue.upsertJobScheduler(key, {
        every: 35_160,
      });

      jobs = await queue.getJobSchedulers();
      expect(jobs).to.have.length(1);

      waitingJobs = await queue.getWaiting();
      expect(waitingJobs).to.have.length(1);
    });
  });

  describe('when pattern option is provided', function () {
    it('should keep only one delayed job if adding a new repeatable job with the same id', async function () {
      const date = new Date('2017-02-07 9:24:00');
      const key = 'mykey';

      this.clock.setSystemTime(date);

      const nextTick = 2 * ONE_SECOND;

      await queue.upsertJobScheduler(
        key,
        {
          pattern: '0 * 1 * *',
        },
        { name: 'test1', data: { foo: 'bar' }, opts: { priority: 1 } },
      );

      this.clock.tick(nextTick);

      let jobs = await queue.getJobSchedulers();
      expect(jobs).to.have.length(1);

      let delayedJobs = await queue.getDelayed();
      expect(delayedJobs).to.have.length(1);

      await queue.upsertJobScheduler(
        key,
        {
          pattern: '0 * 1 * *',
        },
        { name: 'test2', data: { foo: 'baz' }, opts: { priority: 2 } },
      );

      jobs = await queue.getJobSchedulers();
      expect(jobs).to.have.length(1);

      delayedJobs = await queue.getDelayed();
      expect(delayedJobs).to.have.length(1);

      expect(delayedJobs[0].name).to.be.equal('test2');
      expect(delayedJobs[0].data).to.deep.equal({
        foo: 'baz',
      });
      expect(delayedJobs[0].opts).to.deep.include({
        priority: 2,
      });
    });
  });

  // This test is flaky and too complex we need something simpler that tests the same thing
  it.skip('should not re-add a repeatable job after it has been removed', async function () {
    const repeat = await queue.repeat;

    let worker: Worker;
    const jobId = 'xxxx';
    const date = new Date('2017-02-07 9:24:00');
    const nextTick = 2 * ONE_SECOND + 100;
    const addNextRepeatableJob = repeat.updateRepeatableJob;
    this.clock.setSystemTime(date);

    const repeatOpts = { pattern: '*/2 * * * * *' };

    const afterRemoved = new Promise<void>(async resolve => {
      worker = new Worker(
        queueName,
        async () => {
          const repeatWorker = await worker.repeat;
          (<unknown>repeatWorker.updateRepeatableJob) = async (
            ...args: [string, unknown, JobsOptions, boolean?]
          ) => {
            // In order to simulate race condition
            // Make removeRepeatables happen any time after a moveToX is called
            await queue.removeRepeatable('test', repeatOpts, jobId);

            // addNextRepeatableJob will now re-add the removed repeatable
            const result = await addNextRepeatableJob.apply(repeat, args);
            resolve();
            return result;
          };
        },
        { connection, prefix },
      );

      worker.on('completed', () => {
        this.clock.tick(nextTick);
      });
    });

    await queue.add('test', { foo: 'bar' }, { repeat: repeatOpts, jobId });

    this.clock.tick(nextTick);

    await afterRemoved;

    const jobs = await queue.getRepeatableJobs();
    // Repeatable job was recreated
    expect(jobs.length).to.eql(0);

    await worker!.close();
  });

  it('should allow adding a repeatable job after removing it', async function () {
    const repeat = {
      pattern: '*/5 * * * *',
    };

    const worker = new Worker(queueName, NoopProc, { connection, prefix });
    await worker.waitUntilReady();
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    await queue.upsertJobScheduler('myTestJob', repeat, {
      data: {
        data: '2',
      },
    });
    let delayed = await queue.getDelayed();
    expect(delayed.length).to.be.eql(1);

    await new Promise<void>(async (resolve, reject) => {
      queueEvents.on('removed', async ({ jobId, prev }) => {
        try {
          expect(jobId).to.be.equal(delayed[0].id);
          expect(prev).to.be.equal('delayed');
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      try {
        await queue.removeJobScheduler('myTestJob');
      } catch (err) {
        reject(err);
      }
    });

    delayed = await queue.getDelayed();
    expect(delayed.length).to.be.eql(0);

    await queue.upsertJobScheduler('myTestJob', repeat, {
      data: { data: '2' },
    });

    delayed = await queue.getDelayed();
    expect(delayed.length).to.be.eql(1);

    // We need to force close in this case, as closing is too slow in Dragonfly.
    await worker.close(true);
    delayStub.restore();
  }).timeout(8000);

  it('should not allow to remove a delayed job if it belongs to a repeatable job', async function () {
    const date = new Date('2019-07-13 1:58:23');
    this.clock.setSystemTime(date);

    const repeat = {
      every: 1000,
    };

    await queue.upsertJobScheduler('myTestJob', repeat);

    // Get waiting jobs
    const waiting = await queue.getWaiting();
    expect(waiting.length).to.be.eql(1);

    // Try to remove the waiting job
    const job = waiting[0];
    await expect(job.remove()).to.be.rejectedWith(
      `Job ${job.id} belongs to a job scheduler and cannot be removed directly. remove`,
    );
  });

  it('should not remove delayed jobs if they belong to a repeatable job when using drain', async function () {
    const date = new Date('2014-09-03 5:32:12');
    this.clock.setSystemTime(date);

    await queue.upsertJobScheduler('myTestJob', { every: 5000 });
    await queue.add('test', { foo: 'bar' }, { delay: 1000 });

    // Get delayed jobs
    let delayed = await queue.getDelayed();
    expect(delayed.length).to.be.eql(1);

    // Get waiting job count
    const waitingCount = await queue.getWaitingCount();
    expect(waitingCount).to.be.eql(1);

    // Drain the queue
    await queue.drain(true);

    delayed = await queue.getDelayed();
    expect(delayed.length).to.be.eql(0);

    const waiting = await queue.getWaiting();
    expect(waiting.length).to.be.eql(1);

    expect(waiting[0].name).to.be.eql('myTestJob');
  });

  it('should not remove delayed jobs if they belong to a repeatable job when using clean', async function () {
    const date = new Date('2012-08-05 2:32:12');
    this.clock.setSystemTime(date);

    await queue.upsertJobScheduler('myTestJob', { every: 5000 });
    await queue.add('test', { foo: 'bar' }, { delay: 1000 });

    // Get delayed jobs
    const delayed = await queue.getDelayed();
    expect(delayed.length).to.be.eql(1);

    // Get waiting jobs
    let waiting = await queue.getWaiting();
    expect(waiting.length).to.be.eql(1);

    // Clean wait jobs
    await queue.clean(0, 100, 'wait');

    waiting = await queue.getWaiting();
    expect(waiting.length).to.be.eql(1);

    expect(waiting[0].name).to.be.eql('myTestJob');
  });

  it("should keep one delayed job if updating a repeatable job's every option", async function () {
    const date = new Date('2022-01-08 7:22:21');
    this.clock.setSystemTime(date);

    await queue.upsertJobScheduler('myTestJob', { every: 5000 });
    await queue.upsertJobScheduler('myTestJob', { every: 4000 });
    await queue.upsertJobScheduler('myTestJob', { every: 5000 });

    // Get waiting jobs
    const waiting = await queue.getWaiting();
    expect(waiting.length).to.be.eql(1);
  });

  describe('when deleting and upserting a job scheduler', function () {
    it('should not throw error while processing jobs', async function () {
      this.clock.restore();

      const worker = new Worker(
        queueName,
        async () => {
          await queue.removeJobScheduler('foo');
          await queue.upsertJobScheduler(
            'foo',
            { every: 50 },
            {
              name: 'bruh',
              data: { something: 'else' },
            },
          );
        },
        { autorun: false, concurrency: 2, connection, prefix },
      );
      await worker.waitUntilReady();

      await queue.upsertJobScheduler(
        'foo',
        { every: 50 },
        {
          name: 'bruh',
          data: { hello: 'world' },
        },
      );

      let count = 0;
      const completing = new Promise<void>((resolve, reject) => {
        queueEvents.on('completed', async () => {
          await delay(55);
          await queue.upsertJobScheduler(
            'foo',
            { every: 50 },
            {
              name: 'bruh',
              data: { something: 'else' },
            },
          );
          if (count++ > 5) {
            resolve();
          }
        });
        worker.on('error', () => {
          reject();
        });
      });
      worker.run();

      await completing;

      await worker.close();
    }).timeout(4000);
  });

  it('should not repeat more than 5 times', async function () {
    const date = new Date('2017-02-07T09:24:00.000+05:30');
    this.clock.setSystemTime(date);
    const nextTick = ONE_SECOND + 500;

    const worker = new Worker(queueName, NoopProc, { connection, prefix });
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    await queue.upsertJobScheduler('repeat', {
      limit: 5,
      pattern: '*/1 * * * * *',
    });

    const scheduler = await queue.getJobScheduler('repeat');

    expect(scheduler).to.deep.equal({
      iterationCount: 1,
      key: 'repeat',
      limit: 5,
      name: 'repeat',
      pattern: '*/1 * * * * *',
      next: 1486439641000,
    });

    this.clock.tick(nextTick);

    let counter = 0;

    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', () => {
        this.clock.tick(nextTick);
        counter++;
        if (counter == 5) {
          resolve();
        } else if (counter > 5) {
          reject(Error('should not repeat more than 5 times'));
        }
      });
    });

    await completing;
    await worker.close();
    delayStub.restore();
  });

  // This test is not releated to repeatable jobs
  it('should processes delayed jobs by priority', async function () {
    let currentPriority = 1;
    const nextTick = 1000;

    let processor;
    this.clock.setSystemTime(new Date('2017-02-02 7:21:42'));

    const processing = new Promise<void>((resolve, reject) => {
      processor = async (job: Job) => {
        try {
          expect(job.id).to.be.ok;
          expect(job.data.p).to.be.eql(currentPriority++);
        } catch (err) {
          reject(err);
        }

        if (currentPriority > 3) {
          resolve();
        }
      };
    });

    await Promise.all([
      queue.add('test', { p: 1 }, { priority: 1, delay: nextTick * 3 }),
      queue.add('test', { p: 2 }, { priority: 2, delay: nextTick * 2 }),
      queue.add('test', { p: 3 }, { priority: 3, delay: nextTick }),
    ]);

    this.clock.tick(nextTick * 3 + 100);

    const worker = new Worker(queueName, processor, { connection, prefix });
    await worker.waitUntilReady();

    await processing;

    await worker.close();
  });

  it('should use ".every" as a valid interval', async function () {
    const interval = ONE_SECOND * 2;
    const date = new Date('2017-02-07 9:24:00');

    this.clock.setSystemTime(date);

    const nextTick = ONE_SECOND * 2 + 500;

    await queue.upsertJobScheduler(
      'repeat m',
      { every: interval },
      { data: { type: 'm' } },
    );
    await queue.upsertJobScheduler(
      'repeat s',
      { every: interval },
      { data: { type: 's' } },
    );
    this.clock.tick(nextTick);

    const worker = new Worker(queueName, async () => {}, {
      connection,
      prefix,
    });
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});
    await worker.waitUntilReady();

    let prevType: string;
    let counter = 0;

    const completing = new Promise<void>(resolve => {
      worker.on('completed', job => {
        this.clock.tick(nextTick);
        if (prevType) {
          expect(prevType).to.not.be.eql(job.data.type);
        }
        prevType = job.data.type;
        counter++;
        if (counter == 20) {
          resolve();
        }
      });
    });

    await completing;
    await worker.close();
    delayStub.restore();
  });

  it('should repeat every day with a startDate in the future', async function () {
    this.timeout(10000);

    // Set the initial system time
    const initialDate = new Date('2024-01-01 10:00:00');
    this.clock.setSystemTime(initialDate);

    // Set the next tick (repeat interval) and the startDate in the future
    const nextTick = ONE_DAY;
    const startDate = new Date('2024-01-01 10:00:10'); // 10 seconds in the future

    const expectedDates = [
      new Date('2024-01-01 10:00:10'),
      new Date('2024-01-02 10:00:10'),
      new Date('2024-01-03 10:00:10'),
      new Date('2024-01-04 10:00:10'),
      new Date('2024-01-05 10:00:10'),
    ];

    let jobIteration = 0;

    const worker = new Worker(
      queueName,
      async _job => {
        this.clock.tick(nextTick);
      },
      { autorun: false, connection, prefix },
    );

    // Schedule the job with the 'every' interval and a future startDate
    const job = await queue.upsertJobScheduler(
      'test',
      {
        every: ONE_DAY,
        startDate,
      },
      { data: { foo: 'bar' } },
    );

    expect(job).to.be.ok;
    expect(job?.delay).to.be.eql(10000);

    // Simulate the passage of time up to the startDate
    const startDateDelay = startDate.getTime() - initialDate.getTime();
    this.clock.tick(startDateDelay);

    let prev: Job;
    let counter = 0;

    // Promise to resolve when 5 iterations of the job are completed
    const completing = new Promise<void>((resolve, reject) => {
      worker.on('completed', async job => {
        try {
          if (prev) {
            expect(prev.timestamp).to.be.lt(job.timestamp);

            expect(new Date(job.processedOn!)).to.be.eql(
              expectedDates[++jobIteration],
            );

            expect(job.timestamp - prev.timestamp).to.be.gte(2000); // Ensure it's repeating every 2 seconds
          }
          prev = job;
          counter++;
          if (counter == 5) {
            resolve();
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    worker.run();

    await completing;
    await worker.close();
  });

  it('should throw an error when using .pattern and .every simultaneously', async function () {
    await expect(
      queue.upsertJobScheduler('repeat', {
        every: 5000,
        pattern: '* /1 * * * * *',
      }),
    ).to.be.rejectedWith(
      'Both .pattern and .every options are defined for this repeatable job',
    );
  });

  it('should throw an error when not specifying .pattern or .every', async function () {
    await expect(queue.upsertJobScheduler('repeat', {})).to.be.rejectedWith(
      'Either .pattern or .every options must be defined for this repeatable job',
    );
  });

  it('should throw an error when using .immediately and .startDate simultaneously', async function () {
    await expect(
      queue.upsertJobScheduler('repeat', {
        every: 5000,
        immediately: true,
        startDate: new Date(),
      }),
    ).to.be.rejectedWith(
      'Both .immediately and .startDate options are defined for this repeatable job',
    );
  });

  it("should return a valid job with the job's options and data passed as the job template", async function () {
    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);

    const repeatOpts = {
      every: 1000,
    };

    const job = await queue.upsertJobScheduler('test', repeatOpts, {
      data: { foo: 'bar' },
    });

    expect(job).to.be.ok;
    expect(job!.data.foo).to.be.eql('bar');
    expect(job!.opts.repeat!.every).to.be.eql(1000);
  });

  it('should emit a waiting event when adding a repeatable job to the waiting list', async function () {
    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);
    const nextTick = 1 * ONE_SECOND + 500;
    const jobSchedulerId = 'test';

    const worker = new Worker(queueName, async job => {}, {
      connection,
      prefix,
    });
    const delayStub = sinon.stub(worker, 'delay').callsFake(async () => {});

    const waiting = new Promise<void>((resolve, reject) => {
      queueEvents.on('waiting', function ({ jobId }) {
        try {
          expect(jobId).to.be.equal(
            `repeat:${jobSchedulerId}:${date.getTime() + 1 * ONE_SECOND}`,
          );
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    await queue.upsertJobScheduler(jobSchedulerId, {
      pattern: '*/1 * * * * *',
    });
    this.clock.tick(nextTick);

    await waiting;
    await worker.close();
    delayStub.restore();
  });

  it('should have the right count value', async function () {
    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);

    await queue.upsertJobScheduler('test', { every: 1000 });
    this.clock.tick(ONE_SECOND + 100);

    let processor;
    const processing = new Promise<void>((resolve, reject) => {
      processor = async (job: Job) => {
        if (job.opts.repeat!.count === 1) {
          resolve();
        } else {
          reject(new Error('repeatable job got the wrong repeat count'));
        }
      };
    });

    const worker = new Worker(queueName, processor, { connection, prefix });

    await processing;
    await worker.close();
  });

  it('should schedule next "every" repeatable job after promote', async function () {
    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);

    await queue.upsertJobScheduler('scheduler-test', { every: 50000 });
    this.clock.tick(ONE_SECOND + 1000);

    const waitingCountBefore = await queue.getWaitingCount();
    expect(waitingCountBefore).to.be.equal(1);

    let processor;
    const processing1 = new Promise<void>(resolve => {
      processor = async (job: Job) => {
        resolve();
      };
    });

    const worker = new Worker(queueName, processor, { connection, prefix });

    await processing1;

    await worker.close();

    this.clock.tick(ONE_SECOND + 1000);

    const delayedCountBefore = await queue.getDelayedCount();
    expect(delayedCountBefore).to.be.equal(1);

    await queue.promoteJobs();

    this.clock.tick(ONE_SECOND + 1000);

    const waitingCountAfter = await queue.getWaitingCount();
    expect(waitingCountAfter).to.be.equal(1);

    const delayedCountAfter = await queue.getDelayedCount();
    expect(delayedCountAfter).to.be.equal(0);

    const processing2 = new Promise<void>(resolve => {
      processor = async (job: Job) => {
        resolve();
      };
    });

    const worker2 = new Worker(queueName, processor, { connection, prefix });

    await processing2;

    await worker2.close();

    this.clock.tick(ONE_SECOND + 1000);

    const delayedCountAfterProcessing = await queue.getDelayedCount();
    expect(delayedCountAfterProcessing).to.be.equal(1);
  });

  it('should schedule next "pattern" repeatable job after promote', async function () {
    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);

    await queue.upsertJobScheduler('scheduler-test', {
      pattern: '*/1 * * * * *',
    });

    const delayedCountBefore = await queue.getDelayedCount();
    expect(delayedCountBefore).to.be.equal(1);

    await queue.promoteJobs();

    const waitingCountBefore = await queue.getWaitingCount();
    expect(waitingCountBefore).to.be.equal(1);

    let processor;
    const processing1 = new Promise<void>(resolve => {
      processor = async (job: Job) => {
        resolve();
      };
    });

    const worker = new Worker(queueName, processor, { connection, prefix });

    await processing1;

    await worker.close();

    const delayedCountAfter = await queue.getDelayedCount();
    expect(delayedCountAfter).to.be.equal(1);

    const processing2 = new Promise<void>(resolve => {
      processor = async (job: Job) => {
        resolve();
      };
    });

    const worker2 = new Worker(queueName, processor, { connection, prefix });

    this.clock.tick(ONE_SECOND + 1000);

    await processing2;

    await worker2.close();

    this.clock.tick(ONE_SECOND + 1000);

    const delayedCountAfterProcessing = await queue.getDelayedCount();
    expect(delayedCountAfterProcessing).to.be.equal(1);
  });

  it('should schedule next "pattern" repeatable job after promote with immediately', async function () {
    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);

    await queue.upsertJobScheduler('scheduler-test', {
      pattern: '*/1 * * * * *',
      immediately: true,
    });

    const waitingCountBefore = await queue.getWaitingCount();
    expect(waitingCountBefore).to.be.equal(1);

    let processor;
    const processing1 = new Promise<void>(resolve => {
      processor = async (job: Job) => {
        resolve();
      };
    });

    const worker = new Worker(queueName, processor, { connection, prefix });

    await processing1;

    await worker.close();

    const delayedCountAfter = await queue.getDelayedCount();
    expect(delayedCountAfter).to.be.equal(1);

    await queue.promoteJobs();

    const processing2 = new Promise<void>(resolve => {
      processor = async (job: Job) => {
        resolve();
      };
    });

    const worker2 = new Worker(queueName, processor, { connection, prefix });

    this.clock.tick(ONE_SECOND + 1000);

    await processing2;

    await worker2.close();

    this.clock.tick(ONE_SECOND + 1000);

    const delayedCountAfterProcessing = await queue.getDelayedCount();
    expect(delayedCountAfterProcessing).to.be.equal(1);
  });

  it('worker should start processing repeatable jobs after drain', async function () {
    const date = new Date('2017-02-07 9:24:00');
    this.clock.setSystemTime(date);

    await queue.upsertJobScheduler(
      'scheduler-test',
      {
        pattern: '* * * * * *',
      },
      {
        data: { foo: 'bar' },
      },
    );

    this.clock.tick(ONE_SECOND + 1000);

    const delayedCountBeforeDrain = await queue.getDelayedCount();
    expect(delayedCountBeforeDrain).to.be.equal(1);

    await queue.drain(true);

    const delayedCountAfterDrain = await queue.getDelayedCount();
    expect(delayedCountAfterDrain).to.be.equal(1);

    const worker = new Worker(queueName, async () => {}, {
      connection,
      prefix,
    });

    this.clock.tick(ONE_SECOND + 1000);

    const completing = new Promise<void>((resolve, reject) => {
      worker.once('completed', async job => {
        try {
          expect(job).to.be.ok;
          expect(job.data.foo).to.be.eql('bar');
        } catch (err) {
          reject(err);
        }
        resolve();
      });
    });

    await completing;

    await worker.close();
  });
});
