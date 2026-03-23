import * as dotenv from 'dotenv';
dotenv.config();

import { query } from '@anthropic-ai/claude-agent-sdk';

async function test() {
  console.log('[1] Starting test...');
  console.log('[2] KIMI_API_KEY:', process.env.KIMI_API_KEY?.slice(0, 20) + '...');
  console.log('[3] KIMI_BASE_URL:', process.env.KIMI_BASE_URL);
  
  const systemPrompt = 'Respond with valid JSON: { "response": "..." }';
  const userPrompt = 'Say hello';
  
  const combinedPrompt = `INSTRUCTIONS:\n${systemPrompt}\n\n---\n\n${userPrompt}`;
  
  console.log('[4] Starting query...');
  let count = 0;
  let result = '';
  try {
    for await (const message of query({
      prompt: combinedPrompt,
      options: {
        model: 'kimi-k2',
        maxTurns: 1,
        allowedTools: [],
        env: {
          ANTHROPIC_BASE_URL: process.env.KIMI_BASE_URL,
          ANTHROPIC_API_KEY: process.env.KIMI_API_KEY,
        },
      },
    })) {
      count++;
      console.log(`[5.${count}] Got message type:`, (message as any).type);
      if ('result' in message && (message as any).result) {
        result = (message as any).result;
        console.log(`[5.${count}] Got result:`, result.slice(0, 100));
      }
      if (count > 20) {
        console.log('[ERROR] Too many messages, breaking');
        break;
      }
    }
    console.log('[6] Query completed, got', count, 'messages, result:', result.slice(0, 80));
  } catch (err) {
    console.log('[ERROR]', err instanceof Error ? err.message : String(err));
  }
  
  console.log('[7] Done');
}

test().catch(e => console.error('FATAL:', e));
