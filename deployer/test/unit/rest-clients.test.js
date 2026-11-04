/**
Unit tests for the REST clients in src/rest (and the test helper in test/rest), run against a local
stub HTTP server. They check that the axios-based clients behave as the 'request'-based ones did.
*/

import http from 'http';
import assert from 'assert';

let server;
let requests;
let handler;

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const ABI = [
  {
    type: 'function',
    name: 'root',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
  },
];
const ADDRESS = '0x1234567890123456789012345678901234567890';

let merkleTree;
let srcDeployer;
let testDeployer;

before(done => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, raw };
      try {
        record.body = raw ? JSON.parse(raw) : undefined;
      } catch (err) {
        record.body = raw;
      }
      requests.push(record);
      handler(req, res, record);
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    process.env.MERKLE_TREE_HOST = 'http://127.0.0.1';
    process.env.MERKLE_TREE_PORT = String(port);
    process.env.DEPLOYER_HOST = 'http://127.0.0.1';
    process.env.DEPLOYER_PORT = String(port);
    process.env.BLOCKCHAIN_HOST = 'ws://127.0.0.1';
    process.env.BLOCKCHAIN_PORT = '1';
    process.env.NODE_CONFIG = JSON.stringify({ POLLING_FREQUENCY: 20 });
    // config is read at import time, so load the modules only after the env is set:
    merkleTree = require('../../src/rest/merkle-tree').default;
    srcDeployer = require('../../src/rest/deployer').default;
    testDeployer = require('../rest/deployer').default;
    done();
  });
});

after(done => {
  server.close(done);
});

beforeEach(() => {
  requests = [];
  handler = (req, res) => json(res, 200, { data: { ok: true, url: req.url } });
});

describe('src/rest/merkle-tree.js', () => {
  it('startEventFilter POSTs the contractName as JSON to /start and returns body.data', async () => {
    const result = await merkleTree.startEventFilter('MerkleTreeControllerSHA');
    assert.deepStrictEqual(result, { ok: true, url: '/start' });
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].method, 'POST');
    assert.match(requests[0].headers['content-type'], /^application\/json/);
    assert.deepStrictEqual(requests[0].body, { contractName: 'MerkleTreeControllerSHA' });
  });

  it('getSiblingPathByLeafIndex POSTs to /siblingPath/:leafIndex', async () => {
    const result = await merkleTree.getSiblingPathByLeafIndex('C', 7);
    assert.strictEqual(result.url, '/siblingPath/7');
    assert.strictEqual(requests[0].method, 'POST');
    assert.deepStrictEqual(requests[0].body, { contractName: 'C' });
  });

  it('getContractInterface and getContractAddress send GET requests with a JSON body', async () => {
    await merkleTree.getContractInterface('C');
    await merkleTree.getContractAddress('C');
    assert.deepStrictEqual(
      requests.map(r => [r.method, r.url]),
      [
        ['GET', '/metadata/contractInterface'],
        ['GET', '/metadata/contractAddress'],
      ],
    );
    requests.forEach(r => {
      assert.match(r.headers['content-type'], /^application\/json/);
      assert.deepStrictEqual(r.body, { contractName: 'C' });
    });
  });

  it('postContractInterface and postContractAddress POST the contract metadata', async () => {
    await merkleTree.postContractInterface('C', '{"abi":[]}');
    await merkleTree.postContractAddress('C', ADDRESS);
    assert.deepStrictEqual(
      requests.map(r => [r.method, r.url]),
      [
        ['POST', '/metadata/contractInterface'],
        ['POST', '/metadata/contractAddress'],
      ],
    );
    assert.deepStrictEqual(requests[0].body, {
      contractName: 'C',
      contractInterface: '{"abi":[]}',
    });
    assert.deepStrictEqual(requests[1].body, { contractName: 'C', contractAddress: ADDRESS });
  });

  it('postContractInterface keeps polling after a network error until the POST succeeds', async () => {
    let calls = 0;
    handler = (req, res) => {
      calls += 1;
      if (calls < 3) req.socket.destroy();
      else json(res, 200, { data: {} });
    };
    await merkleTree.postContractInterface('C', '{}');
    assert.strictEqual(calls, 3);
  });

  it('insertTreeHeight, insertLeaves and update use the right method and path', async () => {
    await merkleTree.insertTreeHeight('C', 32);
    await merkleTree.insertLeaves('C', [{ value: '0x01', leafIndex: 0 }]);
    await merkleTree.update('C');
    assert.deepStrictEqual(
      requests.map(r => [r.method, r.url]),
      [
        ['POST', '/metadata/treeHeight'],
        ['POST', '/leaves'],
        ['PATCH', '/update'],
      ],
    );
    assert.deepStrictEqual(requests[0].body, { contractName: 'C', treeHeight: 32 });
    assert.deepStrictEqual(requests[1].body, {
      contractName: 'C',
      leaves: [{ value: '0x01', leafIndex: 0 }],
    });
    assert.deepStrictEqual(requests[2].body, { contractName: 'C' });
  });

  it('sends "Connection: close" (no keep-alive), like request on Node 11', async () => {
    await merkleTree.update('C');
    assert.strictEqual(requests[0].headers.connection, 'close');
  });

  it('has no 10MB size limit on request or response bodies', async () => {
    const big = 'f'.repeat(11 * 1024 * 1024);
    handler = (req, res) => json(res, 200, { data: { echo: big } });
    const result = await merkleTree.insertLeaves('C', [{ value: big }]);
    assert.ok(requests[0].raw.length > big.length);
    assert.strictEqual(result.echo.length, big.length);
  });

  it('resolves (does not reject) on HTTP error statuses, returning body.data', async () => {
    handler = (req, res) => json(res, 500, { data: { error: 'boom' } });
    const result = await merkleTree.startEventFilter('C');
    assert.deepStrictEqual(result, { error: 'boom' });
  });

  it('resolves to undefined when the response is not JSON', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not json');
    };
    const result = await merkleTree.startEventFilter('C');
    assert.strictEqual(result, undefined);
  });

  it('rejects on a network error (connection refused)', async () => {
    const closed = http.createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address();
    await new Promise(resolve => closed.close(resolve));
    const httpClient = require('../../src/rest/http-client').default;
    let error;
    try {
      await httpClient.request({ url: `http://127.0.0.1:${port}/start`, method: 'POST', data: {} });
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof Error);
    assert.strictEqual(error.code, 'ECONNREFUSED');
  });
});

const deployerHandler = (req, res, record) => {
  if (req.url === '/contract/address') json(res, 200, { contractAddress: ADDRESS });
  else if (req.url === '/contract/interface') json(res, 200, { contractInterface: { abi: ABI } });
  else json(res, 404, {});
  return record;
};

[
  ['src/rest/deployer.js', () => srcDeployer],
  ['test/rest/deployer.js', () => testDeployer],
].forEach(([name, getClient]) => {
  describe(name, () => {
    it('getContractInstance GETs the address and interface (with a JSON body) and builds a contract', async () => {
      handler = deployerHandler;
      const contractInstance = await getClient().getContractInstance('C');
      assert.deepStrictEqual(
        requests.map(r => [r.method, r.url]),
        [
          ['GET', '/contract/address'],
          ['GET', '/contract/interface'],
        ],
      );
      requests.forEach(r => assert.deepStrictEqual(r.body, { contractName: 'C' }));
      assert.strictEqual(contractInstance.options.address.toLowerCase(), ADDRESS);
      assert.strictEqual(typeof contractInstance.methods.root, 'function');
    });
  });
});
