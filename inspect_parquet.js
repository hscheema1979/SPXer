const DuckDB = require('duckdb-async');
const fs = require('fs');
const path = require('path');

async function main() {
    const db = await DuckDB.Database.create(':memory:');
    
    const testFile = '/home/ubuntu/SPXer/data/parquet/bars/spx-0dte/2026-05-01.parquet';
    
    console.log('File size:', fs.statSync(testFile).size, 'bytes');
    
    try {
        const schema = await db.all(`SELECT * FROM '${testFile}' LIMIT 1`);
        console.log('Schema columns:', Object.keys(schema[0] || {}));
        console.log('First row:', schema[0]);
    } catch (e) {
        console.log('Error:', e.message);
        
        // Try without timestamp filter
        const all = await db.all(`SELECT * FROM '${testFile}' LIMIT 5`);
        console.log('Raw data:', all);
    }
    
    await db.close();
}

main().catch(console.error);
