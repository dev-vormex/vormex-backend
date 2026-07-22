import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createPublicDiscoveryMcpServer,
  OPENAI_APPS_CHALLENGE_PATH,
  OPENAI_APPS_CHALLENGE_TOKEN,
  registerPublicDiscoveryMcp,
} from '../mcp/public-discovery.mcp';

test('OpenAI app verification endpoint returns only the challenge token', async () => {
  const app = express();
  registerPublicDiscoveryMcp(app);
  const httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

  try {
    const address = httpServer.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}${OPENAI_APPS_CHALLENGE_PATH}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^text\/plain/);
    assert.equal(await response.text(), OPENAI_APPS_CHALLENGE_TOKEN);
  } finally {
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('all public discovery tools advertise output schemas and safe read-only annotations', async () => {
  const mcpServer = createPublicDiscoveryMcpServer();
  const client = new Client({ name: 'vormex-submission-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
    for (const tool of tools) {
      assert.ok(tool.outputSchema, `${tool.name} must declare an output schema`);
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be read-only`);
      assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} must not advertise open-world writes`);
      assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} must not be destructive`);
    }
  } finally {
    await client.close();
    await mcpServer.close();
  }
});
