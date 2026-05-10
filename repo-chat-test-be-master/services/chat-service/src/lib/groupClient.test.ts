/**
 * Manual test script for GroupService gRPC client
 * Run: npx tsx src/lib/groupClient.test.ts
 *
 * Requires group-service running on localhost:50055
 */
import 'dotenv/config';
import { getGroupClient, groupChatClient, groupWorkspaceClient, groupChannelClient } from './groupClient.js';
import * as grpc from '@grpc/grpc-js';

const TEST_USER_ID = 'test-user-001';

async function testConnectivity() {
  console.log('\n=== Testing gRPC connectivity to group-service ===');
  console.log(`Target: ${process.env.GROUP_SERVICE_GRPC_ADDR || 'localhost:50055'}`);

  const client = getGroupClient();

  // Check channel state
  const state = client.getChannel().getConnectivityState(true);
  const stateNames = ['IDLE', 'CONNECTING', 'READY', 'TRANSIENT_FAILURE', 'SHUTDOWN'];
  console.log(`Channel state: ${stateNames[state] ?? state}`);
}

async function testGetChats() {
  console.log('\n--- Test: GetChats ---');
  try {
    const result = await groupChatClient.getChats(TEST_USER_ID, 'all');
    console.log('✓ GetChats success:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error('✗ GetChats failed:', err.message, `(code: ${err.code})`);
  }
}

async function testGetUserWorkspaces() {
  console.log('\n--- Test: GetUserWorkspaces ---');
  try {
    const result = await groupWorkspaceClient.getUserWorkspaces(TEST_USER_ID);
    console.log('✓ GetUserWorkspaces success:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error('✗ GetUserWorkspaces failed:', err.message, `(code: ${err.code})`);
  }
}

async function main() {
  await testConnectivity();
  await testGetChats();
  await testGetUserWorkspaces();
  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  // process.exit(1);
});
