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
  
  // Sort by ID (roughly chronological)
  orders.sort((a: any, b: any) => (a.id || 0) - (b.id || 0));
  
  console.log(`Total orders: ${orders.length}`);
  console.log(`\nFirst order: #${orders[0].id} | ${orders[0].create_date} | tag='${orders[0].tag || 'NONE'}'`);
  console.log(`Last order: #${orders[orders.length-1].id} | ${orders[orders.length-1].create_date} | tag='${orders[orders.length-1].tag || 'NONE'}'`);
  
  // Check if any order has a tag
  const tagged = orders.filter((o: any) => o.tag);
  console.log(`\nOrders with tags: ${tagged.length}`);
  if (tagged.length > 0) {
    tagged.slice(0, 5).forEach((o: any) => {
      console.log(`  ${o.id} | tag='${o.tag}' | ${o.create_date}`);
    });
  }
}

main().catch(console.error);
