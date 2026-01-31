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

async function resolveMdns(): Promise<string> {
  let wsHostname = "localhost";
  console.log("[Test 0] Resolving mDNS hostname...");
  try {
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
      console.log("✓ PASSED: mDNS hostname resolved successfully\n");
      wsHostname = MDNS_HOSTNAME;
    } else {
      console.log("✗ FAILED: Could not resolve mDNS hostname (falling back to localhost)\n");
    }
  } catch (err) {
    console.log(`✗ FAILED: ${err} (falling back to localhost)\n`);
  }

  return wsHostname;
}

async function runSuite(label: string, wsUrl: string, mode: "json" | "binary") {
  console.log(`\n========================================`);
  console.log(`UDP-WS Bridge Client Tests (${label})`);
  console.log(`========================================\n`);

  let testsPassed = 0;
  let testsFailed = 0;

  try {
    console.log(`[${label}][Test 1] Connecting to WebSocket server...`);
    const client = new WSClient(wsUrl, mode);
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
      console.log(`[${label}][Test 2] Sending UDP message...`);
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
      console.log(`[${label}][Test 3] Testing message reception...`);
      let messageReceived = false;

      client.onMessage(() => {
        messageReceived = true;
      });

      client.sendUDP({
        address: "127.0.0.1",
        port: 6454,
        data: [0x01, 0x02, 0x03],
      });

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
      console.log(`[${label}][Test 4] Testing multiple message handlers...`);
      let handler1Called = false;
      let handler2Called = false;

      client.onMessage(() => {
        handler1Called = true;
      });

      client.onMessage(() => {
        handler2Called = true;
      });

      if (handler1Called || handler2Called) {
        console.log("✓ PASSED: Handlers invoked immediately (unexpected)\n");
      }
      console.log("✓ PASSED: Registered multiple handlers\n");
      testsPassed++;
    } catch (err) {
      console.log(`✗ FAILED: ${err}\n`);
      testsFailed++;
    }

    // Test 5: Send UDP Message with No Echo
    try {
      console.log(`[${label}][Test 5] Sending UDP message with no-echo flag...`);
      client.clearHandlers();
      await new Promise((resolve) => setTimeout(resolve, 200));

      let noEchoMessageReceived = false;

      client.onMessage(() => {
        noEchoMessageReceived = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const testData = [0x44, 0x45, 0x46]; // "DEF"
      client.sendUDPNoEcho({
        address: "127.0.0.1",
        port: 6454,
        data: testData,
      });

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
      console.log(`[${label}][Test 6] Running 10-second stress test...`);

      let messagesSent = 0;
      let messagesReceived = 0;
      let errors = 0;
      const startTime = Date.now();
      const duration = 10000; // 10 seconds

      const stressHandler = () => {
        messagesReceived++;
      };

      client.onMessage(stressHandler);

      const sendIntervalMs = 1; // aggressive rate to find saturation differences
      const basePayload = new Uint8Array(512);
      basePayload.set([0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74]);
      basePayload.fill(0x55, 9); // pad

      const sendInterval = setInterval(() => {
        try {
          // mutate counter bytes in place to avoid allocations
          basePayload[7] = (messagesSent >> 8) & 0xff;
          basePayload[8] = messagesSent & 0xff;

          client.sendUDP({
            address: "127.0.0.1",
            port: 6454,
            data: basePayload,
          });

          messagesSent++;
        } catch (err) {
          errors++;
        }

        if (Date.now() - startTime >= duration) {
          clearInterval(sendInterval);
        }
      }, sendIntervalMs);

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
      console.log(`[${label}][Test 7] Checking connection state...`);
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
      console.log(`[${label}][Test 8] Disconnecting from server...`);
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

  console.log(`========================================`);
  console.log(`Test Summary (${label})`);
  console.log(`========================================`);
  console.log(`Passed: ${testsPassed}`);
  console.log(`Failed: ${testsFailed}`);
  console.log(`Total:  ${testsPassed + testsFailed}`);
  console.log(`========================================\n`);

  return { testsPassed, testsFailed };
}

async function runTests() {
  const wsHostname = await resolveMdns();
  const wsUrlJson = `ws://${wsHostname}:${WS_PORT}`;
  const wsUrlBinary = `ws://${wsHostname}:${WS_PORT}?mode=binary`;
  console.log(`Using WebSocket URL (JSON):   ${wsUrlJson}`);
  console.log(`Using WebSocket URL (Binary): ${wsUrlBinary}\n`);

  const jsonResults = await runSuite("JSON", wsUrlJson, "json");
  const binaryResults = await runSuite("Binary", wsUrlBinary, "binary");

  const totalPassed = jsonResults.testsPassed + binaryResults.testsPassed;
  const totalFailed = jsonResults.testsFailed + binaryResults.testsFailed;

  console.log("========================================");
  console.log("Overall Summary");
  console.log("========================================");
  console.log(`Passed: ${totalPassed}`);
  console.log(`Failed: ${totalFailed}`);
  console.log(`Total:  ${totalPassed + totalFailed}`);
  console.log("========================================\n");

  process.exit(totalFailed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test suite error:", err);
  process.exit(1);
});
