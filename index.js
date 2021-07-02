'use strict';

module.exports.noLimiter = {schedule: async asyncRunner => asyncRunner()};

module.exports.asyncTimeout = async (delayMs) => {
    return new Promise(function (resolve) {
        setTimeout(resolve, delayMs);
    });
};

module.exports.allSettledParallelLimited = async ({
                                                      jobs,
                                                      jobToPromise = job => job(),
                                                      maxParallel,
                                                      retryMs = 10,
                                                      logger = () => {
                                                      },
                                                      logRetries = false
                                                  }) => {
    const runs = [];
    let runningCount = 0;
    for (let i = 0; i < jobs.length; i++) {
        while (runningCount >= maxParallel) {
            if (logRetries) {
                logger(`Running ${i}/${jobs.length} jobs, max parallel count reached (${runningCount}), waiting for ${retryMs}ms`);
            }
            await exports.asyncTimeout(retryMs);
        }

        runningCount++;
        logger(`Started ${i}/${jobs.length} (parallel=${runningCount})`);

        const job = jobs[i];
        jobToPromise(job).then(value => {
            runningCount--;
            return runs.push({status: 'fulfilled', value});
        }).catch(error => {
            runningCount--;
            return runs.push({status: 'rejected', reason: {error, job}});
        });
    }

    while (runningCount >= 1) {
        if (logRetries) {
            logger(`Waiting for runs to complete (${runningCount}), waiting for ${retryMs}ms`);
        }
        await exports.asyncTimeout(5 * retryMs);
    }

    return runs;
};

module.exports.ParallelLimiter = class {
    constructor({
                    maxParallel = 1,
                    retryMs = 10,
                    logger = () => {
                    }, logRetries = false
                } = {}) {
        this.maxParallel = maxParallel;
        this.retryMs = retryMs;
        this.logger = logger?.debug ?? logger;
        this.logRetries = logRetries;
        this.runningCount = 0;
    }

    async schedule(promiseProvider) {
        while (this.runningCount >= this.maxParallel) {
            if (this.logRetries) {
                this.logger(`Max parallel count reached (${this.runningCount}), waiting for ${this.retryMs}ms`);
            }
            await exports.asyncTimeout(this.retryMs);
        }

        this.runningCount++;
        this.logger(`Started Promise (${this.runningCount}/${this.maxParallel} running)`);
        const promise = promiseProvider();
        try {
            const value = await promise;
            this.runningCount--;
            this.logger(`Finalized Promise (${this.runningCount}/${this.maxParallel} running)`);
            return value;
        } catch (e) {
            this.runningCount--;
            this.logger(`Failed Promise (${this.runningCount}/${this.maxParallel} running): ${e.message}`);
            throw e;
        }
    }
};
