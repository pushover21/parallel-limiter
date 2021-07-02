import {expect} from 'chai';
import nock from 'nock';
import axios from 'axios';
import {performance} from 'perf_hooks';
import Bottleneck from 'bottleneck';
import {ParallelLimiter} from "../index.js";
import {mockHttpGetResponses} from "./helpers.mjs";
import pkg from 'posix';

const {setrlimit} = pkg;

async function testWithinSetup({
                                   maxParallel = 10,
                                   retryMs = 200,
                                   logRetries = true,
                                   expectRetries = false,
                                   test,
                               } = {}) {
    const loggedMessages = [];
    let limiterParams = {
        maxParallel,
        retryMs,
        logger: (...messages) => {
            loggedMessages.push(...messages);
        },
        logRetries,
    };
    const limiter = new ParallelLimiter(limiterParams);

    const result = await test(limiter);

    if (limiterParams.logger) {
        expect(loggedMessages).to.deep.include.members([
            `Started Promise (1/${limiterParams.maxParallel} running)`,
            `Finalized Promise (0/${limiterParams.maxParallel} running)`
        ]);
    }

    if (logRetries && expectRetries) {
        expect(loggedMessages).to.deep.include.members([
            `Max parallel count reached (${limiterParams.maxParallel}), waiting for ${limiterParams.retryMs}ms`
        ]);
    }

    return result;
}

async function profileParallelRun({limiter, runInParallel, useHttpServer = false}) {
    const {urlBasePath, uris, mockedResponses, server} = await mockHttpGetResponses({
        runInParallel,
        useHttpServer
    });
    let promisesToSchedule;
    let highestHeapUsage = 0;
    let maxRunInParallel = 0;
    let runningInParallel = 0;
    if (false === limiter) {
        promisesToSchedule = uris.map(uri => () => axios.get(`${urlBasePath}${uri}`));
    } else {
        promisesToSchedule = uris.map(uri => () => limiter.schedule(() => {
            highestHeapUsage = Math.max(highestHeapUsage, process.memoryUsage().heapUsed);
            runningInParallel++;
            maxRunInParallel = Math.max(maxRunInParallel, runningInParallel);
            return axios.get(`${urlBasePath}${uri}`).then(response => {
                runningInParallel--;
                return {response, uri};
            }).catch(e => {
                runningInParallel--;
                throw e;
            });
        }));
    }

    const start = performance.now();
    const cpuUsageAtStart = process.cpuUsage();
    const heapUsageAtStart = process.memoryUsage().heapUsed;
    const responses = await Promise.all(promisesToSchedule.map(p => p()));
    // noinspection JSCheckFunctionSignatures
    const cpuUsage = process.cpuUsage(cpuUsageAtStart);
    const elapsedMs = performance.now() - start;

    server.close();

    const stats = {
        maxRunInParallel,
        elapsedMs,
        cpuUsage,
        cpuUsagePerMs: {user: cpuUsage.user / elapsedMs, system: cpuUsage.system / elapsedMs},
        highestMemoryUsed: highestHeapUsage - heapUsageAtStart
    };
    console.debug(`Finished parallel-limited ${runInParallel} downloads, stats: ${JSON.stringify(stats)}`);

    if (limiter) {
        responses.forEach(({response, uri}) =>
            expect(response.data).to.deep.equal(mockedResponses[uri]));
    }

    return stats;
}

async function testThreeWays({
                                 runInParallel,
                                 maxParallel = runInParallel,
                                 passes = 5,
                                 useHttpServer = false,
                                 expectedOverhead
                             }) {
    setrlimit('nofile', {soft: 100 * 1000});

    const overheads = [];
    const bottleneckOverheads = [];
    for (let pass = 0; pass < passes; pass++) {
        global.gc();
        const {elapsedMs: parallelLimiterElapsedMs} = await profileParallelRun({
            runInParallel, useHttpServer,
            limiter: new ParallelLimiter({maxParallel})
        });
        global.gc();
        const {elapsedMs: noLimiterElapsedMs} = await profileParallelRun({
            runInParallel, useHttpServer,
            limiter: false
        });
        global.gc();
        const {elapsedMs: bottleneckElapsedMs} = await profileParallelRun({
            runInParallel, useHttpServer,
            limiter: new Bottleneck({maxConcurrent: maxParallel})
        });

        const overhead = parallelLimiterElapsedMs / noLimiterElapsedMs;
        const bottleneckOverhead = bottleneckElapsedMs / noLimiterElapsedMs;
        console.info(`Unfettered run under parallel-limiter was ~${(100 * (overhead - 1)).toFixed(1)}% slower than no limiter`);
        console.info(`Unfettered run under Bottleneck was ~${(100 * (bottleneckOverhead - 1)).toFixed(1)}% slower than no limiter`);
        overheads.push(overhead);
        bottleneckOverheads.push(bottleneckOverhead);
    }
    const averageSlowerThanPercentage = overheads.reduce((sum, o) => sum + o - 1, 0) / overheads.length;
    console.info(`On average, unfettered run under parallel-limiter was ~${(100 * averageSlowerThanPercentage).toFixed(1)}% slower than no limiter`);
    const bottleneckAverageSlowerThanPercentage = bottleneckOverheads.reduce((sum, o) => sum + o - 1, 0) / bottleneckOverheads.length;
    console.info(`On average, unfettered run under Bottleneck was ~${(100 * bottleneckAverageSlowerThanPercentage).toFixed(1)}% slower than no limiter`);
    expect(averageSlowerThanPercentage).to.be.lessThanOrEqual(expectedOverhead);

    const speedFactor = bottleneckAverageSlowerThanPercentage / averageSlowerThanPercentage;
    console.info(`Overhead of an unfettered run under parallel-limiter was ${speedFactor.toFixed(1)}x faster than under Bottlneck`);
    expect(speedFactor).to.be.greaterThanOrEqual(10);
}

describe(`Parallel Limiter`, () => {
    it(`should mirror async function behavior when scheduled`, async () => {
        await testWithinSetup({
            test: async (limiter) => {
                const urlBasePath = 'https://mocked-url';
                const uri = '/mocked-uri';
                let mockedResponseBody = {
                    numbers: [1, 2, 3],
                    keywords: {message1: 'Message #1', message2: 'Message #2'}
                };
                nock(urlBasePath).get(uri).reply(200, mockedResponseBody);
                const awaitedResponse = await limiter.schedule(() => axios.get(`${urlBasePath}${uri}`));

                nock(urlBasePath).get(uri).reply(200, mockedResponseBody);
                const scheduledResponse = await limiter.schedule(() => axios.get(`${urlBasePath}${uri}`));
                expect(scheduledResponse.data).to.deep.equal(awaitedResponse.data);
            }
        });
    });
    it(`should schedule 50-parallel-limited 1K downloads within 2s`, async function () {
        // noinspection JSUnresolvedFunction
        this.timeout(4000);
        const maxParallel = 50;
        const runInParallel = 1000;
        await testWithinSetup({
            maxParallel,
            retryMs: 10,
            expectRetries: true,
            test: async (limiter) => {
                const {maxRunInParallel, elapsedMs} = await profileParallelRun({runInParallel, limiter});
                expect(maxRunInParallel).to.equal(maxParallel);
                expect(elapsedMs).to.be.lessThanOrEqual(2000);
            }
        });
    });
    it(`should use less memory and CPU when doing fewer retries`, async function () {
        // noinspection JSUnresolvedFunction
        this.timeout(5000);
        const maxParallel = 10;
        const runInParallel = 100;
        global.gc();
        const frequentRetriesStats = await profileParallelRun({
            runInParallel,
            limiter: new ParallelLimiter({maxParallel, retryMs: 1})
        });
        const fewerRetriesStats = await profileParallelRun({
            runInParallel,
            limiter: new ParallelLimiter({maxParallel, retryMs: 20})
        });

        expect(frequentRetriesStats.highestMemoryUsed).to.be.greaterThanOrEqual(fewerRetriesStats.highestMemoryUsed);
        expect(frequentRetriesStats.cpuUsagePerMs.user).to.be.greaterThanOrEqual(fewerRetriesStats.cpuUsagePerMs.user);
        expect(frequentRetriesStats.cpuUsagePerMs.system).to.be.greaterThanOrEqual(fewerRetriesStats.cpuUsagePerMs.system);
    });
    it(`should have less than 30% overhead vs a no-limiter setup and 10x less overhead vs Bottleneck in a 1K nock & axios.get unfettered run`, async function () {
        this.timeout(30 * 1000);
        await testThreeWays({
            runInParallel: 1000,
            passes: 5,
            useHttpServer: false,
            expectedOverhead: 0.3,
        });
    });
    it(`should have less than 2x overhead vs a no-limiter setup and 50x less overhead vs Bottleneck in a 150 http.createSerer & axios.get unfettered run`, async function () {
        this.timeout(20 * 1000);
        await testThreeWays({
            runInParallel: 150,
            passes: 5,
            useHttpServer: true,
            expectedOverhead: 1,
        });
    });
    it(`should be at least 8x faster than bottleneck in a 1K axios.get unfettered run`, async function () {
        this.timeout(5000);
        const maxParallel = 1000;
        const runInParallel = 1000;
        const {elapsedMs: parallelLimiterElapsedMs} = await profileParallelRun({
            runInParallel,
            limiter: new ParallelLimiter({maxParallel})
        });
        const {elapsedMs: bottleneckElapsedMs} = await profileParallelRun({
            runInParallel,
            limiter: new Bottleneck({maxConcurrent: maxParallel})
        });

        const speedFactor = bottleneckElapsedMs / parallelLimiterElapsedMs;
        console.info(`Unfettered run under parallel-limiter was ${speedFactor.toFixed(1)}x faster than under Bottlneck`);
        expect(speedFactor).to.be.greaterThanOrEqual(8);
    });
    it(`should be at least 4x faster than bottleneck in a 1K 100-parallel-limited run`, async function () {
        this.timeout(80000);
        for (const useHttpServer of [false, true]) {
            const maxParallel = 100;
            const runInParallel = 1000;
            const {elapsedMs: parallelLimiterElapsedMs} = await profileParallelRun({
                runInParallel,
                limiter: new ParallelLimiter({maxParallel, retryMs: 10}),
                useHttpServer,
            });
            const {elapsedMs: bottleneckElapsedMs} = await profileParallelRun({
                runInParallel,
                limiter: new Bottleneck({maxConcurrent: maxParallel}),
                useHttpServer,
            });

            const speedFactor = bottleneckElapsedMs / parallelLimiterElapsedMs;
            console.info(`Unfettered run under parallel-limiter was ${speedFactor.toFixed(1)}x faster than under Bottlneck`);
            expect(speedFactor).to.be.greaterThanOrEqual(4);
        }
    });
    it(`should be at least as fast as bottleneck in a 1K synchronous (1-parallel-limited) run (retryMs=3)`, async function () {
        this.timeout(10000);
        const maxParallel = 1;
        const runInParallel = 500;
        const {elapsedMs: parallelLimiterElapsedMs} = await profileParallelRun({
            runInParallel,
            limiter: new ParallelLimiter({maxParallel, retryMs: 3})
        });
        const {elapsedMs: bottleneckElapsedMs} = await profileParallelRun({
            runInParallel,
            limiter: new Bottleneck({maxConcurrent: maxParallel})
        });

        const speedFactor = bottleneckElapsedMs / parallelLimiterElapsedMs;
        console.info(`1-parallel-limited run (synchronous) under parallel-limiter was ${speedFactor.toFixed(1)}x faster than under Bottlneck`);
        expect(speedFactor).to.be.greaterThanOrEqual(1);
    });
    it(`should use less memory, CPU, and CPU/ms while same speed as Bottleneck`, async function () {
        // noinspection JSUnresolvedFunction
        this.timeout(10000);
        const maxParallel = 25;
        const runInParallel = 1000;
        global.gc();
        const stats = await profileParallelRun({
            runInParallel,
            limiter: new ParallelLimiter({maxParallel, retryMs: 50})
        });
        global.gc();
        const bottleneckStat = await profileParallelRun({
            runInParallel,
            limiter: new Bottleneck({maxConcurrent: maxParallel})
        });

        const speedFactor = bottleneckStat.elapsedMs / stats.elapsedMs;
        console.info(`CPU comparison run under parallel-limiter is ${speedFactor.toFixed(1)}x faster than under Bottlneck`);
        expect(speedFactor).to.be.greaterThanOrEqual(1);

        expect(stats.cpuUsage.user).to.be.lessThanOrEqual(bottleneckStat.cpuUsage.user);
        expect(stats.cpuUsage.system).to.be.lessThanOrEqual(bottleneckStat.cpuUsage.system);

        expect(stats.cpuUsagePerMs.user).to.be.lessThanOrEqual(bottleneckStat.cpuUsagePerMs.user);
        expect(stats.cpuUsagePerMs.system).to.be.lessThanOrEqual(bottleneckStat.cpuUsagePerMs.system);

        expect(stats.highestMemoryUsed).to.be.lessThanOrEqual(bottleneckStat.highestMemoryUsed);
    });
});
