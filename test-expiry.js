#!/usr/bin/env node
// Test script to verify expired pendings are properly cleaned up

const { createDbClient } = require('./src/db-cli');

async function test() {
  console.log('🧪 Testing pending expiry cleanup...\n');
  
  const db = createDbClient();
  
  // Create a pending that expires in 5 seconds
  const expDate = new Date(Date.now() + 5000).toISOString();
  const joinid = 'test-' + Date.now();
  const client1 = 'device-test-1';
  
  console.log('1️⃣  Creating pending with 5-second expiry...');
  console.log('   joinid:', joinid);
  console.log('   client1:', client1);
  console.log('   exp:', expDate);
  
  await db.createPending({ joinid, exp: expDate, client1 });
  console.log('✅ Pending created\n');
  
  // Check immediately - should be found
  console.log('2️⃣  Checking pending immediately...');
  let status = await db.checkPending({ joinid, client1 });
  console.log('   Status:', status.status);
  if (status.status === 'pending') {
    console.log('✅ Found as expected\n');
  } else {
    console.log('❌ FAILED: Should be pending\n');
    process.exit(1);
  }
  
  // Wait 6 seconds for expiry
  console.log('3️⃣  Waiting 6 seconds for expiry...');
  await new Promise(resolve => setTimeout(resolve, 6000));
  console.log('   Time elapsed\n');
  
  // Check again - should be not_found (cleaned up)
  console.log('4️⃣  Checking pending after expiry...');
  status = await db.checkPending({ joinid, client1 });
  console.log('   Status:', status.status);
  if (status.status === 'not_found') {
    console.log('✅ Successfully cleaned up!\n');
  } else {
    console.log('❌ FAILED: Should be not_found (expired)\n');
    process.exit(1);
  }
  
  // Try to accept expired pending
  console.log('5️⃣  Trying to accept expired pending...');
  const result = await db.acceptPendingToRoom({ 
    joinid, 
    client2: 'device-test-2', 
    roomid: 'test-room-123' 
  });
  console.log('   Result:', result);
  if (!result.ok && result.code === 404) {
    console.log('✅ Correctly rejected expired pending\n');
  } else {
    console.log('❌ FAILED: Should reject with 404\n');
    process.exit(1);
  }
  
  console.log('🎉 All tests passed!');
}

test().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
