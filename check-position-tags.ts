import { config } from './src/config';
import axios from 'axios';

async function main() {
  // Check if tags appear in positions endpoint
  const { data: posData } = await axios.get(`https://api.tradier.com/v1/accounts/6YA51425/positions`, {
    headers: {
      'Authorization': `Bearer ${config.tradierToken}`,
      'Accept': 'application/json'
    }
  });
  
  const positions = posData?.positions?.position;
  if (positions && Array.isArray(positions)) {
    console.log(`\nPositions (${positions.length}):`);
    positions.forEach((p: any) => {
      console.log(`  ${p.symbol} | qty=${p.quantity} | tag='${p.tag || 'NONE'}' | cost_basis=${p.cost_basis}`);
    });
  } else {
    console.log('No positions');
  }
  
  // Check orders again with full response
  console.log(`\n--- Full Order Response Sample ---`);
  const { data: orderData } = await axios.get(`https://api.tradier.com/v1/accounts/6YA51425/orders/122882357`, {
    headers: {
      'Authorization': `Bearer ${config.tradierToken}`,
      'Accept': 'application/json'
    }
  });
  
  console.log(JSON.stringify(orderData, null, 2).substring(0, 1500));
}

main().catch(console.error);
