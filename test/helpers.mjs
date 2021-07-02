import nock from "nock";
import http from "http";

export async function mockHttpGetResponses({runInParallel = 1, useHttpServer = false}) {
    const httpListenPort = 8888;
    const urlBasePath = useHttpServer ? `http://localhost:${httpListenPort}` : 'https://mocked-url';
    const mockedResponses = {};
    const uris = [];
    for (let jobIndex = 0; jobIndex < runInParallel; jobIndex++) {
        let mockedResponseBody = {
            numbers: [1, 2, 3, jobIndex],
            keywords: {
                message1: 'Message #1', message2: 'Message #2',
                message3: `Message ${jobIndex}`
            }
        };
        const uri = `/mocked-uri${jobIndex}`;

        if (useHttpServer) {

        } else {
            nock(urlBasePath).get(uri).reply(200, mockedResponseBody);
        }

        mockedResponses[uri] = mockedResponseBody;
        uris.push(uri);
    }

    let server = {close: () => {}};
    if (useHttpServer) {
        server = http.createServer((req, res) => {
            res.setHeader("Content-Type", "application/json");
            res.writeHead(200);
            res.end(JSON.stringify(mockedResponses[req.url]));
        });

        await new Promise((resolve) => {
            server.listen({
                port: httpListenPort,
                host: 'localhost',
                exclusive: true
            }, () => {
                console.log(`Started HTTP Server`);
                resolve();
            });
        });
    }

    return {urlBasePath, uris, mockedResponses, server};
}
