# Parallel Limiter
A simple solution to limit parallel Node.js async calls with low performance overhead.

<!-- toc -->
- [How to use](#how-to-use)
- [allSettledParallelLimited](#parallel-limited-promiseallsettled-function)
<!-- tocstop -->

## Quick Start
To parallel-limit a call to an async function or Promise `asyncFunction(...)` replace with:
```js
limiter.schedule(() => asyncFunction(...params));
```
See [below](#how-to-use) the two steps in setting up a `limiter`.

## Benchmarks
| Total | Limit | `parallel-limit` | `bottleneck` |
|----|--------|---------|-------------|
| 1,000 | 1,000 | 30% overhead vs no limiter | ~70x more overhead than `parallel-limit` |
| 1,000 | 100 | - | 10x slower than `parallel-limit` |
| 1,000 | 1 | (using faster retry interval) | 1.4x slower than `parallel-limit` |

Tested using mocked HTTP downloads and real HTTPS server with similar results.

Tests available in the [test](test) directory. 

These tests show `parallel-limiter` has up to 70x less overhead than `bottleneck`
and can run up to 10x faster in a typical unit test mocked HTTP request scenario.

## Why performance overhead matters
* Production code may not always hit the rate limits - yet the app run slower
* Unit tests may run 12-15x faster, e.g. when mocking HTTP connections

## Use cases
* Need to stay within REST API License restrictions, e.g. no more than `10` parallel requests
* Run your code under [AWS Lambda restrictions](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html), e.g. file descriptor and thread limits
* Avoid hitting Machine memory limits due to multiplying your memory footprint with every parallel call
* Avoid performance degradation due to CPU overload from too many parallel calls
* Other scenarios where your app must comply with hardware/platform resource limitations and remote request endpoint rate limits

## Prerequisites
You will need to run Node.js 14.x or newer (or [Browser equivalent](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Nullish_coalescing_operator)).

## How to use

1. Identify all `await` calls that should be part of the same limiting criterion
1. Import the `ParallelLimiter` class, e.g. from am ES Module:
   ```js
   import {ParallelLimiter} from 'parallel-limiter';
   ```
   This is how to import from a CommonJS module:
   ```js
   const {ParallelLimiter} = require('parallel-limiter');
   ```
1. Create a limiter passing the parallel call limit (e.g. `100`) as follows:
   ```js
   const limiter = new ParallelLimiter({maxParallel: 100});
   ```
1. Replace every `await` call that is to be limited by the same limiter:
   ```js
   const result = await asyncFunction(...params);
   ```
   with:
   ```js
   const result = await limiter.schedule(() => asyncFunction(...params));
   ```

### Parallel limited `Promise.allSettled` function
This package also comes with a convenience function `allSettledParallelLimited`
that behaves similar to
[Promise.allSettled](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled)
which can be run using a specified parallel limit.

Assuming this `Promise.all` or `Promise.allSettled` based code:
```js
const results = Promise.allSettled(task.map(async () => createAPromiseFromTask(task)));
```
you may add the parallel limiting behavior by importing (from an ES Module):
```js
import {allSettledParallelLimited} from 'parallel-limiter';
```
or requiring (from a CommonJS modules):
```js
const {allSettledParallelLimited} = require('parallel-limiter');
```
and changing the `Promise.allSettled` code to:
```js
const results = allSettledParallelLimited({
   jobs: task,
   jobToPromise: async () => createAPromiseFromTask(task),
   maxParallel: 100,
});
```

All promises will be run simultaneously without exceeding the
number of `maxParallel` promises (here `100`) running at the same time.

## Fine tuning
* In case your code is not fast enough, decrease the `retryMs` parameter value, e.g. set to `3`ms
* In case your code is using up too much memory, increase the `retryMs` parameter value, e.g. set to `200`ms, e.g.
   ```js
   const limiter = new ParallelLimiter({maxParallel: 100, retryMs: 3});
   ```

## Moving to/from `bottleneck`
`package-limiter` may be used interchangeably with the `bottleneck` `limiter.schedule()` function,
allowing you to code against both packages, e.g. if you encounter issues or limitations
with one package over the other.

See the [test](test) directory for benchmark comparisons and how both packages are used.
