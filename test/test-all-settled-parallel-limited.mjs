import {expect} from "chai";
import axios from "axios";
import {mockHttpGetResponses} from "./helpers.mjs";
import {allSettledParallelLimited} from "../index.js";

async function setup({runInParallel, maxParallel, useHttpServer = false, logger, logRetries}) {
    const {urlBasePath, uris, mockedResponses, server} = await mockHttpGetResponses({
        runInParallel,
        useHttpServer
    });

    const results = await allSettledParallelLimited({
        jobs: uris, maxParallel,
        jobToPromise: uri => axios.get(`${urlBasePath}${uri}`).then(response => {
            return {response, uri};
        }),
        logger,
        logRetries
    });

    server.close();

    results.forEach(result => {
        expect(result.status).to.equal('fulfilled');
        expect(result.value.response.data).to.deep.equal(mockedResponses[result.value.uri]);
    });
}

describe(`allSettledParallelLimited`, () => {
    it(`should work`, async () => {
        await setup({
            runInParallel: 1000, maxParallel: 50,
            logger: console.debug, logRetries: true,
        });
    });
});
