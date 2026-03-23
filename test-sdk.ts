import * as dotenv from 'dotenv';
dotenv.config();

import { query } from '@anthropic-ai/claude-agent-sdk';

async function testSDK() {
  console.log('Testing Agent SDK with MiniMax (slowest)...');
  const startTime = Date.now();
  
  try {
    let count = 0;
    for await (const message of query({
      prompt: 'Respond with valid JSON: { "test": "hello" }',
      options: {
        model: 'MiniMax-M2.7',
        maxTurns: 1,
        allowedTools: [],
        env: {
          ANTHROPIC_BASE_URL: process.env.MINIMAX_BASE_URL,
          ANTHROPIC_API_KEY: process.env.MINIMAX_API_KEY,
        },
      },
    })) {
      count++;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[${elapsed}s] message ${count}:`, (message as any).type);
      if (count > 30) break;
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${elapsed}s] Complete with ${count} messages`);
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${elapsed}s] ERROR:`, err instanceof Error ? err.message : String(err));
  }
}

testSDK();
