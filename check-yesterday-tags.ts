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
  
  // Group by date
  const byDate: Record<string, any[]> = {};
  orders.forEach((o: any) => {
    const date = o.create_date?.split('T')?.[0] || 'unknown';
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(o);
  });
  
  // Show last 5 days
  Object.keys(byDate).sort().reverse().slice(0, 5).forEach(date => {
    const dayOrders = byDate[date];
    const tagged = dayOrders.filter((o: any) => o.tag).length;
    console.log(`\n${date}: ${dayOrders.length} orders, ${tagged} tagged`);
    dayOrders.slice(0, 3).forEach((o: any) => {
      console.log(`  ${o.id} | tag='${o.tag || 'NONE'}' | ${o.status}`);
    });
  });
}

main().catch(console.error);
