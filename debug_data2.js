const DuckDB = require('duckdb-async');

async function main() {
    const db = await DuckDB.Database.create(':memory:');
    
    const query = `
        SELECT ts, symbol, open, high, low, close, timeframe
        FROM '/home/ubuntu/SPXer/data/parquet/bars/spx-0dte/2026-05-01.parquet'
        WHERE symbol = 'SPX' AND timeframe = '1m'
        ORDER BY ts
        LIMIT 20
    `;
    
    const result = await db.all(query);
    console.log('Sample SPX 1m bars from 2026-05-01:');
    result.forEach(r => {
        const d = new Date(r.ts * 1000);
        console.log(`${d.toISOString().substring(11,19)} | O:${r.open.toFixed(0)} H:${r.high.toFixed(0)} L:${r.low.toFixed(0)} C:${r.close.toFixed(0)}`);
    });
    
    console.log('\nTotal SPX 1m candles:');
    const count = await db.all(`SELECT COUNT(*) as cnt FROM '/home/ubuntu/SPXer/data/parquet/bars/spx-0dte/2026-05-01.parquet' WHERE symbol = 'SPX' AND timeframe = '1m'`);
    console.log(count[0]);
    
    console.log('\nUnique symbols:');
    const symbols = await db.all(`SELECT DISTINCT symbol FROM '/home/ubuntu/SPXer/data/parquet/bars/spx-0dte/2026-05-01.parquet'`);
    console.log(symbols);
    
    await db.close();
}

main().catch(console.error);

