#!/bin/bash
# Demo script to run server and tests

echo "Starting UDP-WS Bridge server..."
bun run main.ts &
SERVER_PID=$!

echo "Waiting for server to start..."
sleep 2

echo "Running client tests..."
bun run client.test.ts

echo "Killing server..."
kill $SERVER_PID

exit 0
