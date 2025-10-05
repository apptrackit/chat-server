#!/usr/bin/env node

/**
 * Test script for the updated /api/user/purge endpoint
 * Tests both single ID (backward compatibility) and array of IDs (new feature)
 */

const BASE_URL = process.env.TEST_URL || 'http://localhost:8080';

async function testPurge() {
  console.log('🧪 Testing /api/user/purge endpoint\n');
  console.log(`Base URL: ${BASE_URL}\n`);

  // Test 1: Array of device IDs (new format)
  console.log('Test 1: Array of device IDs (preferred format)');
  try {
    const response = await fetch(`${BASE_URL}/api/user/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIds: [
          'test-device-id-1',
          'test-device-id-2',
          'test-device-id-3'
        ]
      })
    });
    
    const data = await response.json();
    console.log(`✅ Status: ${response.status}`);
    console.log(`✅ Response:`, JSON.stringify(data, null, 2));
    
    if (data.deviceIdCount === 3) {
      console.log('✅ Correct device count returned\n');
    } else {
      console.log('❌ Expected deviceIdCount: 3, got:', data.deviceIdCount, '\n');
    }
  } catch (error) {
    console.error('❌ Test 1 failed:', error.message, '\n');
  }

  // Test 2: Single device ID (backward compatibility)
  console.log('Test 2: Single device ID (backward compatibility)');
  try {
    const response = await fetch(`${BASE_URL}/api/user/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'legacy-device-id'
      })
    });
    
    const data = await response.json();
    console.log(`✅ Status: ${response.status}`);
    console.log(`✅ Response:`, JSON.stringify(data, null, 2));
    
    if (data.deviceIdCount === 1) {
      console.log('✅ Backward compatibility works!\n');
    } else {
      console.log('❌ Expected deviceIdCount: 1, got:', data.deviceIdCount, '\n');
    }
  } catch (error) {
    console.error('❌ Test 2 failed:', error.message, '\n');
  }

  // Test 3: Empty array (should fail gracefully)
  console.log('Test 3: Empty array (should fail)');
  try {
    const response = await fetch(`${BASE_URL}/api/user/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIds: []
      })
    });
    
    const data = await response.json();
    console.log(`✅ Status: ${response.status}`);
    console.log(`✅ Response:`, JSON.stringify(data, null, 2));
    
    if (response.status === 400) {
      console.log('✅ Correctly rejected empty array\n');
    } else {
      console.log('❌ Should have returned 400 status\n');
    }
  } catch (error) {
    console.error('❌ Test 3 failed:', error.message, '\n');
  }

  // Test 4: Missing parameters (should fail)
  console.log('Test 4: Missing parameters (should fail)');
  try {
    const response = await fetch(`${BASE_URL}/api/user/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    
    const data = await response.json();
    console.log(`✅ Status: ${response.status}`);
    console.log(`✅ Response:`, JSON.stringify(data, null, 2));
    
    if (response.status === 400) {
      console.log('✅ Correctly rejected missing parameters\n');
    } else {
      console.log('❌ Should have returned 400 status\n');
    }
  } catch (error) {
    console.error('❌ Test 4 failed:', error.message, '\n');
  }

  // Test 5: Invalid IDs (empty strings)
  console.log('Test 5: Invalid IDs (empty strings)');
  try {
    const response = await fetch(`${BASE_URL}/api/user/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIds: ['valid-id', '', 'another-valid-id']
      })
    });
    
    const data = await response.json();
    console.log(`✅ Status: ${response.status}`);
    console.log(`✅ Response:`, JSON.stringify(data, null, 2));
    
    if (response.status === 400) {
      console.log('✅ Correctly rejected invalid IDs\n');
    } else {
      console.log('❌ Should have returned 400 status\n');
    }
  } catch (error) {
    console.error('❌ Test 5 failed:', error.message, '\n');
  }

  console.log('🎉 All tests completed!');
}

// Run tests
testPurge().catch(console.error);
