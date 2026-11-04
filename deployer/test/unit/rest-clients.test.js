/* eslint-disable global-require */
import assert from 'assert';
import express from 'express';

// Starts a stub HTTP server that records every request it receives.
const startStubServer = handler =>
  new Promise(resolve => {
    const app = express();
    const calls = [];
    app.use(express.json({ limit: '50mb' }));
    app.use((req, res) => {
      calls.push({
        method: req.method,
        path: req.path,
        body: req.body,
        headers: req.headers,
      });
      handler(req, res, calls.length);
    });
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, calls }));
  });

const closeServer = ({ server }) => new Promise(resolve => server.close(resolve));

describe('REST clients (axios replacement for request)', () => {
  let stub;
  let merkleTree;
  let deployerRest;
  let httpClient;
  let failFirstPost = false;

  before(async () => {
    stub = await startStubServer((req, res, callCount) => {
      if (req.path === '/fail') return res.status(500).json({ error: 'boom' });
      if (req.path === '/text') return res.status(200).send('not json');
      if (failFirstPost && callCount === 1) return req.socket.destroy();
      if (req.path === '/contract/address')
        return res.json({ contractAddress: '0x0000000000000000000000000000000000000001' });
      if (req.path === '/contract/interface') return res.json({ contractInterface: { abi: [] } });
      return res.json({ data: { echo: req.body, method: req.method } });
    });
    const { port } = stub.server.address();
    process.env.MERKLE_TREE_HOST = 'http://127.0.0.1';
    process.env.MERKLE_TREE_PORT = port;
    process.env.DEPLOYER_HOST = 'http://127.0.0.1';
    process.env.DEPLOYER_PORT = port;
    process.env.NODE_CONFIG = JSON.stringify({ POLLING_FREQUENCY: 50 });

    merkleTree = require('../../src/rest/merkle-tree').default;
    deployerRest = require('../../src/rest/deployer').default;
    httpClient = require('../../src/rest/http-client').default;
  });

  beforeEach(() => {
    stub.calls.length = 0;
    failFirstPost = false;
  });

  after(() => closeServer(stub));

  const cases = [
    ['startEventFilter', ['MyTree'], 'POST', '/start', { contractName: 'MyTree' }],
    [
      'getSiblingPathByLeafIndex',
      ['MyTree', 7],
      'POST',
      '/siblingPath/7',
      { contractName: 'MyTree' },
    ],
    [
      'getContractInterface',
      ['MyTree'],
      'GET',
      '/metadata/contractInterface',
      { contractName: 'MyTree' },
    ],
    [
      'getContractAddress',
      ['MyTree'],
      'GET',
      '/metadata/contractAddress',
      { contractName: 'MyTree' },
    ],
    [
      'insertTreeHeight',
      ['MyTree', 32],
      'POST',
      '/metadata/treeHeight',
      { contractName: 'MyTree', treeHeight: 32 },
    ],
    [
      'insertLeaves',
      ['MyTree', [{ value: '0x01' }]],
      'POST',
      '/leaves',
      { contractName: 'MyTree', leaves: [{ value: '0x01' }] },
    ],
    ['update', ['MyTree'], 'PATCH', '/update', { contractName: 'MyTree' }],
  ];

  cases.forEach(([fn, args, method, path, body]) => {
    it(`merkle-tree ${fn} sends ${method} ${path} with a JSON body and returns body.data`, async () => {
      const result = await merkleTree[fn](...args);
      assert.strictEqual(stub.calls.length, 1);
      const [call] = stub.calls;
      assert.strictEqual(call.method, method);
      assert.strictEqual(call.path, path);
      assert.deepStrictEqual(call.body, body);
      assert.match(call.headers['content-type'], /^application\/json/);
      assert.strictEqual(call.headers.connection, 'close');
      assert.deepStrictEqual(result, { echo: body, method });
    });
  });

  it('postContractInterface and postContractAddress POST to the metadata endpoints', async () => {
    await merkleTree.postContractInterface('MyTree', '{"abi":[]}');
    await merkleTree.postContractAddress('MyTree', '0xabc');
    assert.deepStrictEqual(
      stub.calls.map(c => [c.method, c.path, c.body]),
      [
        [
          'POST',
          '/metadata/contractInterface',
          { contractName: 'MyTree', contractInterface: '{"abi":[]}' },
        ],
        ['POST', '/metadata/contractAddress', { contractName: 'MyTree', contractAddress: '0xabc' }],
      ],
    );
  });

  it('postContractInterface keeps polling after a network error until it succeeds', async () => {
    failFirstPost = true;
    await merkleTree.postContractInterface('MyTree', '{}');
    assert.strictEqual(stub.calls.length, 2);
  });

  it('sends large request bodies (>10MB) without a size limit', async () => {
    const leaves = Array.from({ length: 200000 }, (_, i) => ({ value: `0x${'ab'.repeat(32)}`, i }));
    const result = await merkleTree.insertLeaves('MyTree', leaves);
    assert.ok(JSON.stringify(stub.calls[0].body).length > 10 * 1024 * 1024);
    assert.strictEqual(result.echo.leaves.length, 200000);
  });

  it('resolves (does not reject) on HTTP error statuses, like request did', async () => {
    const res = await httpClient.request({
      url: `${process.env.MERKLE_TREE_HOST}:${process.env.MERKLE_TREE_PORT}/fail`,
    });
    assert.strictEqual(res.status, 500);
    assert.deepStrictEqual(res.data, { error: 'boom' });
  });

  it('returns non-JSON response bodies as plain strings, like request did', async () => {
    const res = await httpClient.request({
      url: `${process.env.MERKLE_TREE_HOST}:${process.env.MERKLE_TREE_PORT}/text`,
    });
    assert.strictEqual(res.data, 'not json');
  });

  it('rejects on network errors, like request did', async () => {
    let error;
    try {
      await httpClient.request({ url: 'http://127.0.0.1:1/unreachable' });
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof Error);
    assert.strictEqual(error.code, 'ECONNREFUSED');
  });

  it('deployer getContractInstance fetches address and interface with GET + JSON body', async () => {
    const instance = await deployerRest.getContractInstance('MyTree');
    assert.strictEqual(instance.options.address, '0x0000000000000000000000000000000000000001');
    assert.deepStrictEqual(
      stub.calls.map(c => [c.method, c.path, c.body]),
      [
        ['GET', '/contract/address', { contractName: 'MyTree' }],
        ['GET', '/contract/interface', { contractName: 'MyTree' }],
      ],
    );
  });
});
