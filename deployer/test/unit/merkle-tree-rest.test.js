/**
Unit tests for the deployer's HTTP client calls to the merkle-tree microservice.
They run against a local stub server, so no blockchain or docker services are needed.
*/

import assert from 'assert';
import http from 'http';
import express from 'express';
import bodyParser from 'body-parser';

let server;
let port;
let merkleTree;
let received;
let reply;

const startStubServer = () =>
  new Promise(resolve => {
    const app = express();
    app.use(bodyParser.json({ limit: '100mb' }));
    app.all('*', (req, res) => {
      received = {
        method: req.method,
        path: req.path,
        body: req.body,
        headers: req.headers,
      };
      const { status = 200, body = { data: 'ok' }, dropConnection } = reply;
      if (dropConnection) {
        req.socket.destroy();
        return;
      }
      res.status(status).json(body);
    });
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });

describe('merkle-tree REST client', function() {
  this.timeout(30000);

  before(async () => {
    server = await startStubServer();
    ({ port } = server.address());
    process.env.MERKLE_TREE_HOST = 'http://127.0.0.1';
    process.env.MERKLE_TREE_PORT = `${port}`;
    // eslint-disable-next-line global-require
    merkleTree = require('../../src/rest/merkle-tree').default;
  });

  after(() => new Promise(resolve => server.close(resolve)));

  beforeEach(() => {
    received = undefined;
    reply = {};
  });

  const cases = [
    {
      fn: 'startEventFilter',
      args: ['Tree'],
      method: 'POST',
      path: '/start',
      body: { contractName: 'Tree' },
    },
    {
      fn: 'getSiblingPathByLeafIndex',
      args: ['Tree', 7],
      method: 'POST',
      path: '/siblingPath/7',
      body: { contractName: 'Tree' },
    },
    {
      fn: 'getContractInterface',
      args: ['Tree'],
      method: 'GET',
      path: '/metadata/contractInterface',
      body: { contractName: 'Tree' },
    },
    {
      fn: 'getContractAddress',
      args: ['Tree'],
      method: 'GET',
      path: '/metadata/contractAddress',
      body: { contractName: 'Tree' },
    },
    {
      fn: 'insertTreeHeight',
      args: ['Tree', 32],
      method: 'POST',
      path: '/metadata/treeHeight',
      body: { contractName: 'Tree', treeHeight: 32 },
    },
    {
      fn: 'insertLeaves',
      args: ['Tree', [{ value: '0x01', leafIndex: 0 }]],
      method: 'POST',
      path: '/leaves',
      body: { contractName: 'Tree', leaves: [{ value: '0x01', leafIndex: 0 }] },
    },
    {
      fn: 'update',
      args: ['Tree'],
      method: 'PATCH',
      path: '/update',
      body: { contractName: 'Tree' },
    },
  ];

  cases.forEach(({ fn, args, method, path, body }) => {
    it(`${fn} sends ${method} ${path} with a JSON body and resolves to body.data`, async () => {
      reply = { body: { data: { fn } } };
      const result = await merkleTree[fn](...args);
      assert.strictEqual(received.method, method);
      assert.strictEqual(received.path, path);
      assert.ok(/application\/json/.test(received.headers['content-type']));
      assert.deepStrictEqual(received.body, body);
      assert.deepStrictEqual(result, { fn });
    });
  });

  it('resolves (does not reject) on an HTTP error status', async () => {
    reply = { status: 500, body: { error: 'boom' } };
    const result = await merkleTree.getContractAddress('Tree');
    assert.strictEqual(result, undefined);
  });

  it('resolves to body.data on an HTTP error status that includes data', async () => {
    reply = { status: 404, body: { data: 'not found' } };
    const result = await merkleTree.update('Tree');
    assert.strictEqual(result, 'not found');
  });

  it('sends large payloads (over 10MB) without a size limit', async () => {
    const leaves = Array.from({ length: 150000 }, (_, i) => ({
      value: `0x${i.toString(16).padStart(64, '0')}`,
      leafIndex: i,
      blockNumber: 0,
    }));
    reply = { body: { data: 'inserted' } };
    const result = await merkleTree.insertLeaves('Tree', leaves);
    assert.strictEqual(result, 'inserted');
    assert.strictEqual(received.body.leaves.length, leaves.length);
  });

  it('postContractInterface and postContractAddress send the contract details', async () => {
    await merkleTree.postContractInterface('Tree', '{"abi":[]}');
    assert.strictEqual(received.method, 'POST');
    assert.strictEqual(received.path, '/metadata/contractInterface');
    assert.deepStrictEqual(received.body, {
      contractName: 'Tree',
      contractInterface: '{"abi":[]}',
    });

    await merkleTree.postContractAddress('Tree', '0xabc');
    assert.strictEqual(received.method, 'POST');
    assert.strictEqual(received.path, '/metadata/contractAddress');
    assert.deepStrictEqual(received.body, { contractName: 'Tree', contractAddress: '0xabc' });
  });

  it('rejects when the connection to the merkle-tree service fails', async () => {
    reply = { dropConnection: true };
    await assert.rejects(merkleTree.startEventFilter('Tree'));
  });
});
