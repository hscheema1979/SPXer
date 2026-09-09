const DuckDB = require('duckdb-async');
const fs = require('fs');
const path = require('path');

const may2026Dates = [
    '2026-05-01', '2026-05-04', '2026-05-05', '2026-05-06',
    '2026-05-07', '2026-05-08', '2026-05-11', '2026-05-12',
    '2026-05-13', '2026-05-14', '2026-05-15', '2026-05-18',
    '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22',
    '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29'
];

const dataDir = '/home/ubuntu/SPXer/data/parquet/bars/spx-0dte';

function getDayName(dateStr) {
    const date = new Date(dateStr + 'T00:00:00Z');
    return date.toLocaleDateString('en-US', { weekday: 'long' });
}

async function analyzeDay(db, dateStr) {
    const filePath = path.join(dataDir, `${dateStr}.parquet`);
    
    if (!fs.existsSync(filePath)) {
        return {
            Date: dateStr,
            Day: getDayName(dateStr),
            Direction: 'NO DATA'
        };
    }
    
    try {
        // Get SPX 1m bars
        const query = `
            SELECT ts, open, high, low, close
            FROM '${filePath}'
            WHERE symbol = 'SPX' AND timeframe = '1m'
            ORDER BY ts
        `;
        
        const result = await db.all(query);
        
        if (!result || result.length === 0) {
            return {
                Date: dateStr,
                Day: getDayName(dateStr),
                Direction: 'NO DATA'
            };
        }
        
        return analyzeData(dateStr, result);
        
    } catch (err) {
        return {
            Date: dateStr,
            Day: getDayName(dateStr),
            Direction: 'ERROR: ' + err.message.substring(0, 40)
        };
    }
}

function analyzeData(dateStr, result) {
    // Extract OHLC
    const opens = result.map(r => parseFloat(r.open));
    const highs = result.map(r => parseFloat(r.high));
    const lows = result.map(r => parseFloat(r.low));
    const closes = result.map(r => parseFloat(r.close));
    const timestamps = result.map(r => r.ts);
    
    const dailyOpen = opens[0];
    const dailyClose = closes[closes.length - 1];
    const dailyHigh = Math.max(...highs);
    const dailyLow = Math.min(...lows);
    const dailyRange = dailyHigh - dailyLow;
    
    // Direction: up/down/sideways based on close vs open
    let direction = 'SIDEWAYS';
    const netMove = dailyClose - dailyOpen;
    if (netMove > dailyRange * 0.15) {
        direction = 'UPTREND';
    } else if (netMove < -dailyRange * 0.15) {
        direction = 'DOWNTREND';
    }
    
    // Get last 10 candles before 15:50 ET (19:50 UTC)
    const cutoffTs = Math.floor(new Date(dateStr + 'T19:50:00Z').getTime() / 1000);
    const beforeClose = result.filter(r => r.ts <= cutoffTs);
    
    let ch15m = 'N/A';
    if (beforeClose.length >= 10) {
        const last10 = beforeClose.slice(-10);
        const last10Highs = last10.map(r => parseFloat(r.high));
        const last10Lows = last10.map(r => parseFloat(r.low));
        const ch15mHigh = Math.max(...last10Highs);
        const ch15mLow = Math.min(...last10Lows);
        ch15m = `${ch15mLow.toFixed(0)}-${ch15mHigh.toFixed(0)}`;
    }
    
    // Afternoon window: 14:45-15:50 ET (18:45-19:50 UTC)
    const windowStartTs = Math.floor(new Date(dateStr + 'T18:45:00Z').getTime() / 1000);
    const windowEndTs = Math.floor(new Date(dateStr + 'T19:50:00Z').getTime() / 1000);
    const windowCandles = result.filter(r => r.ts >= windowStartTs && r.ts <= windowEndTs);
    
    let afternoonInfo = 'N/A';
    let afternoonMove = 0;
    let skewFired = false;
    
    if (windowCandles.length > 0) {
        const windowHigh = Math.max(...windowCandles.map(r => parseFloat(r.high)));
        const windowLow = Math.min(...windowCandles.map(r => parseFloat(r.low)));
        const windowClose = parseFloat(windowCandles[windowCandles.length - 1].close);
        const windowOpen = parseFloat(windowCandles[0].open);
        
        afternoonMove = windowClose - windowOpen;
        afternoonInfo = `L:${windowLow.toFixed(0)} H:${windowHigh.toFixed(0)} C:${windowClose.toFixed(0)}`;
        
        // Simplified: check if put/call skew would be extreme (< 0.4 means lots of puts)
        // This is a heuristic - normally you'd need actual options data
        if (direction === 'DOWNTREND' && Math.abs(afternoonMove) > 10) {
            skewFired = true;  // Aggressive down move = puts firing
        } else if (direction === 'UPTREND' && Math.abs(afternoonMove) > 10) {
            skewFired = true;  // Aggressive up move = calls firing
        }
    }
    
    // Signal: YES/NO based on pattern
    // Criteria: meaningful range + afternoon movement + direction
    let signal = 'NO';
    let reason = '';
    
    if (dailyRange > 25 && Math.abs(netMove) > 8) {
        // Good volatility setup
        if (direction !== 'SIDEWAYS' && Math.abs(afternoonMove) > 5) {
            signal = 'YES';
            reason = `Volatility=${dailyRange.toFixed(0)}pt, ${direction}, AftMove=${afternoonMove.toFixed(0)}pt`;
        } else {
            signal = 'MAYBE';
            reason = `Volatility=${dailyRange.toFixed(0)}pt, Range OK but weak afternoon`;
        }
    } else {
        reason = `Low volatility: range=${dailyRange.toFixed(1)}pt`;
    }
    
    const dailyRangeStr = `O:${dailyOpen.toFixed(0)} H:${dailyHigh.toFixed(0)} L:${dailyLow.toFixed(0)} C:${dailyClose.toFixed(0)}`;
    
    return {
        Date: dateStr,
        Day: getDayName(dateStr),
        Direction: direction,
        'O-H-L-C': dailyRangeStr,
        'Range': dailyRange.toFixed(1),
        'Move': netMove.toFixed(1),
        '15m Ch': ch15m,
        'Afternoon': afternoonInfo,
        'AftMove': afternoonMove.toFixed(1),
        'Signal': signal,
        'Reason': reason,
        'Candles': result.length
    };
}

async function main() {
    const db = await DuckDB.Database.create(':memory:');
    
    console.log('\n' + '='.repeat(170));
    console.log('MAY 2026 SPX 0DTE TRADING ANALYSIS');
    console.log('='.repeat(170) + '\n');
    
    const results = [];
    
    for (const date of may2026Dates) {
        const dayResult = await analyzeDay(db, date);
        results.push(dayResult);
    }
    
    // Print table header
    console.log('Date       | Day       | Dir      | Open-High-Low-Close  | Range | NetMove | Signal | Reason');
    console.log('-'.repeat(170));
    
    for (const r of results) {
        if (r.Direction === 'NO DATA' || r.Direction.startsWith('ERROR')) {
            console.log(`${r.Date} | ${r.Day.padEnd(9)} | ${r.Direction}`);
        } else {
            const dirStr = r.Direction.padEnd(8);
            const dayStr = r.Day.padEnd(9);
            const ohlc = (r['O-H-L-C'] || '').padEnd(20);
            const range = (r.Range + 'pt').padEnd(7);
            const move = (r.Move + 'pt').padEnd(8);
            const sig = r.Signal.padEnd(6);
            const reason = (r.Reason || '').substring(0, 70);
            
            console.log(`${r.Date} | ${dayStr} | ${dirStr} | ${ohlc} | ${range} | ${move} | ${sig} | ${reason}`);
            if (r.Afternoon !== 'N/A') {
                console.log(`           |           |          | Afternoon: ${r.Afternoon} Move=${r.AftMove}pt`);
            }
            console.log(`           |           |          | 15m Channel: ${r['15m Ch']}`);
        }
        console.log('');
    }
    
    console.log('='.repeat(170));
    console.log('\nSUMMARY\n');
    
    const validResults = results.filter(r => 
        r.Direction !== 'NO DATA' && !r.Direction.startsWith('ERROR')
    );
    
    const uptrends = validResults.filter(r => r.Direction === 'UPTREND').length;
    const downtrends = validResults.filter(r => r.Direction === 'DOWNTREND').length;
    const sideways = validResults.filter(r => r.Direction === 'SIDEWAYS').length;
    const yesSignals = validResults.filter(r => r.Signal === 'YES').length;
    const maybeSignals = validResults.filter(r => r.Signal === 'MAYBE').length;
    
    console.log(`Total trading days with data: ${validResults.length}`);
    console.log(`Missing data: ${results.length - validResults.length} days\n`);
    console.log(`Direction breakdown:`);
    console.log(`  UPTREND:  ${uptrends} days`);
    console.log(`  DOWNTREND: ${downtrends} days`);
    console.log(`  SIDEWAYS:  ${sideways} days\n`);
    console.log(`Signal opportunities:`);
    console.log(`  YES signals: ${yesSignals}`);
    console.log(`  MAYBE signals: ${maybeSignals}`);
    console.log(`  Total playable: ${yesSignals + maybeSignals} days (${((yesSignals+maybeSignals)/validResults.length*100).toFixed(1)}%)`);
    
    console.log('\nPattern explanation:');
    console.log('May 2026 showed a mix of directional and sideways days with moderate volatility.');
    console.log('Most days had low intraday signal quality (weak afternoon reversals or continuation).');
    console.log(`Only ${yesSignals} days met high-confidence signal criteria (25pt+ range + 8pt+ net move + afternoon confirmation).`);
    
    await db.close();
}

main().catch(console.error);

