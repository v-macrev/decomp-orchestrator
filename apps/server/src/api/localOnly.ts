// SPDX-License-Identifier: AGPL-3.0-or-later
// Without a token the API trusts whoever reaches this machine's loopback address, and that includes
// any website open in a browser here: a page can send requests to 127.0.0.1, and a name it controls
// can be made to resolve there. So only requests addressed to a local name are answered, and a request
// that names a page it comes from must name a local one.
import type { FastifyInstance } from 'fastify';

const LOCAL_HOST = /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?$/i;
const LOCAL_ORIGIN = /^https?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?$/i;

export function localOnly(f: FastifyInstance) {
  f.addHook('onRequest', async (req, reply) => {
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return reply.code(403).send({ error: 'this server answers on this machine only' });
    const origin = req.headers.origin;
    if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) return reply.code(403).send({ error: 'requests from other sites are refused' });
    // A browser also says where a request comes from when it sends no Origin.
    if (req.url.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'requests from other sites are refused' });
  });
}
