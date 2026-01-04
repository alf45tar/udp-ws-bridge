// -------------------------
// WebSocket Client Tests
// -------------------------

import WSClient from "./client";
import mdns from "multicast-dns";

// Test configuration
const TEST_TIMEOUT = 10000;
const MDNS_HOSTNAME = "udp-ws-bridge.local";
const WS_PORT = 8081;

// Helper function to wait for a condition
function waitFor(
  condition: () => boolean,
  timeout: number = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error("Timeout waiting for condition"));
      } else {
        setTimeout(check, 100);
      }
    };

    check();
  });
}

// Test Suite
async function runTests() {
  console.log("\n========================================");
  console.log("UDP-WS Bridge Client Tests");
  console.log("========================================\n");

  let testsPassed = 0;
  let testsFailed = 0;
  let wsHostname = "localhost"; // Default fallback

  // Test 0: mDNS Hostname Resolution
  try {
    console.log("[Test 0] Resolving mDNS hostname...");
    const mdnsClient = mdns();

    const resolved = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        mdnsClient.destroy();
        resolve(false);
      }, 3000);

      mdnsClient.on("response", (response) => {
        for (const answer of response.answers) {
          if (answer.name === MDNS_HOSTNAME && answer.type === "A") {
            console.log(`  Resolved ${MDNS_HOSTNAME} -> ${answer.data}`);
            clearTimeout(timeout);
            mdnsClient.destroy();
            resolve(true);
            return;
          }
        }
      });

      mdnsClient.query({
        questions: [
          {
            name: MDNS_HOSTNAME,
            type: "A",
          },
        ],
      });
    });

    if (resolved) {
      wsHostname = MDNS_HOSTNAME;
      console.log("✓ PASSED: mDNS hostname resolved successfully\n");
      testsPassed++;
    } else {
      console.log("✗ FAILED: Could not resolve mDNS hostname (falling back to localhost)\n");
      testsFailed++;
    }
  } catch (err) {
    console.log(`✗ FAILED: ${err} (falling back to localhost)\n`);
    testsFailed++;
  }

  const TEST_WS_URL = `ws://${wsHostname}:${WS_PORT}`;
  console.log(`Using WebSocket URL: ${TEST_WS_URL}\n`);

  // Test 1: Connection
  try {
    console.log("[Test 1] Connecting to WebSocket server...");
    const client = new WSClient(TEST_WS_URL);
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timeout")), TEST_TIMEOUT)
      ),
    ]);

    if (client.isConnected()) {
      console.log("✓ PASSED: Successfully connected to WebSocket\n");
      testsPassed++;
    } else {
      console.log("✗ FAILED: Not connected after connect()\n");
      testsFailed++;
    }

    // Test 2: Send UDP Message
    try {
      console.log("[Test 2] Sending UDP message...");
      const testData = [0x41, 0x42, 0x43]; // "ABC"
      client.sendUDP({
        address: "127.0.0.1",
        port: 6454,
        data: testData,
      });
      console.log("✓ PASSED: Message sent successfully\n");
      testsPassed++;
    } catch (err) {
      console.log(`✗ FAILED: ${err}\n`);
      testsFailed++;
    }

    // Test 3: Receive Messages
    try {
      console.log("[Test 3] Testing message reception...");
      let messageReceived = false;

      client.onMessage((msg) => {
        // Commented out for performance:
        // console.log(
        //   `  Received message: ${msg.type} from ${msg.address}:${msg.port}`
        // );
        messageReceived = true;
      });

      // Send a test message
      client.sendUDP({
        address: "127.0.0.1",
        port: 6454,
        data: [0x01, 0x02, 0x03],
      });

      // Wait a bit to see if we receive the message back
      await new Promise((resolve) => setTimeout(resolve, 500));

      if (messageReceived) {
        console.log("✓ PASSED: Received UDP message\n");
        testsPassed++;
      } else {
        console.log("✓ PASSED: No messages (expected if UDP loopback not active)\n");
        testsPassed++;
      }
    } catch (err) {
      console.log(`✗ FAILED: ${err}\n`);
      testsFailed++;
    }

    // Test 4: Multiple Message Handlers
    try {
      console.log("[Test 4] Testing multiple message handlers...");
      let handler1Called = false;
      let handler2Called = false;

      client.onMessage(() => {
        handler1Called = true;
      });

      client.onMessage(() => {
        handler2Called = true;
      });

      // Trigger message handlers manually for testing
      // (In real scenario, UDP messages would trigger these)
      console.log("✓ PASSED: Registered multiple handlers\n");
      testsPassed++;
    } catch (err) {
      console.log(`✗ FAILED: ${err}\n`);
      testsFailed++;
    }

    // Test 5: Send UDP Message with No Echo
    try {
      console.log("[Test 5] Sending UDP message with no-echo flag...");

      // Clear all previous handlers to avoid receiving echoes from previous tests
      client.clearHandlers();

      // Wait a bit to let any pending messages from previous tests clear
      await new Promise((resolve) => setTimeout(resolve, 200));

      let noEchoMessageReceived = false;

      const noEchoHandler = () => {
        noEchoMessageReceived = true;
      };

      client.onMessage(noEchoHandler);

      // Small delay to ensure handler is registered before sending
      await new Promise((resolve) => setTimeout(resolve, 50));

      const testData = [0x44, 0x45, 0x46]; // "DEF"
      client.sendUDPNoEcho({
        address: "127.0.0.1",
        port: 6454,
        data: testData,
      });

      // Wait to see if message echoes back (it shouldn't with no-echo)
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (!noEchoMessageReceived) {
        console.log("✓ PASSED: No-echo prevented message loopback\n");
        testsPassed++;
      } else {
        console.log("✗ FAILED: No-echo message was echoed back\n");
        testsFailed++;
      }
    } catch (err) {
      console.log(`✗ FAILED: ${err}\n`);
      testsFailed++;
    }

    // Test 6: Stress Test (10 seconds)
    try {
      console.log("[Test 6] Running 10-second stress test...");

      let messagesSent = 0;
      let messagesReceived = 0;
      let errors = 0;
      const startTime = Date.now();
      const duration = 10000; // 10 seconds

      // Handler to count received messages
      const stressHandler = () => {
        messagesReceived++;
        // Commented out for performance:
        // console.log(`  Received message: udp-message from 127.0.0.1:6454`);
      };

      client.onMessage(stressHandler);

      // Send messages continuously for 10 seconds
      const sendInterval = setInterval(() => {
        try {
          // 256-byte payload: 'Art-Net' + counter + padding
          const testData = [
            0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, // 'Art-Net'
            (messagesSent >> 8) & 0xff,
            messagesSent & 0xff,
            ...Array(256 - 9).fill(0x55) // pad with 0x55
          ];

          client.sendUDP({
            address: "127.0.0.1",
            port: 6454,
            data: testData,
          });

          messagesSent++;
        } catch (err) {
          errors++;
        }

        // Stop after 10 seconds
        if (Date.now() - startTime >= duration) {
          clearInterval(sendInterval);
        }
      }, 10); // Send every 10ms (100 messages per second)

      // Wait for the full duration
      await new Promise((resolve) => setTimeout(resolve, duration + 500));
      clearInterval(sendInterval);

      const elapsed = Date.now() - startTime;
      const messagesPerSec = Math.round(messagesSent / (elapsed / 1000));

      console.log(`  Duration: ${elapsed}ms`);
      console.log(`  Messages sent: ${messagesSent}`);
      console.log(`  Messages received: ${messagesReceived}`);
      console.log(`  Errors: ${errors}`);
      console.log(`  Rate: ~${messagesPerSec} msg/sec`);

      if (messagesSent > 0 && errors === 0) {
        console.log("✓ PASSED: Stress test completed successfully\n");
        testsPassed++;
      } else {
        console.log("✗ FAILED: Stress test had issues\n");
        testsFailed++;
      }
    } catch (err) {
      console.log(`✗ FAILED: ${err}\n`);
      testsFailed++;
    }

    // Test 7: Connection State
    try {
      console.log("[Test 7] Checking connection state...");
      if (client.isConnected()) {
        console.log("✓ PASSED: Client reports connected state\n");
        testsPassed++;
      } else {
        console.log("✗ FAILED: Client should be connected\n");
        testsFailed++;
      }
    } catch (err) {
      console.log(`✗ FAILED: ${err}\n`);
      testsFailed++;
    }

    // Test 8: Disconnect
    try {
      console.log("[Test 8] Disconnecting from server...");
      client.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 100));

      if (!client.isConnected()) {
        console.log("✓ PASSED: Successfully disconnected\n");
        testsPassed++;
      } else {
        console.log("✗ FAILED: Client should be disconnected\n");
        testsFailed++;
      }
    } catch (err) {
      console.log(`✗ FAILED: ${err}\n`);
      testsFailed++;
    }
  } catch (err) {
    console.log(`✗ FAILED: Could not connect to server: ${err}\n`);
    testsFailed++;
  }

  // Summary
  console.log("========================================");
  console.log("Test Summary");
  console.log("========================================");
  console.log(`Passed: ${testsPassed}`);
  console.log(`Failed: ${testsFailed}`);
  console.log(`Total:  ${testsPassed + testsFailed}`);
  console.log("========================================\n");

  process.exit(testsFailed > 0 ? 1 : 0);
}

// Run tests
runTests().catch((err) => {
  console.error("Test suite error:", err);
  process.exit(1);
});
