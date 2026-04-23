import { config } from './src/config';
import axios from 'axios';

async function main() {
  const { data } = await axios.get(`https://api.tradier.com/v1/accounts/6YA51425/orders`, {
    headers: {
      'Authorization': `Bearer ${config.tradierToken}`,
      'Accept': 'application/json'
    }
  });
  
  let orders = data?.orders?.order;
  if (!orders) {
    console.log('No orders found');
    return;
  }
  orders = Array.isArray(orders) ? orders : [orders];
  
  // Show last 10 orders
  console.log(`\nLast 10 orders:\n`);
  orders.slice(-10).reverse().forEach((o: any) => {
    const tag = o.tag || 'NONE';
    const symbol = o.option_symbol || '(multi-leg)';
    const status = o.status || '?';
    const createdAt = o.create_date || '?';
    console.log(`Order ${o.id} | tag='${tag}' | ${status} | ${symbol}`);
  });
}

main().catch(console.error);
