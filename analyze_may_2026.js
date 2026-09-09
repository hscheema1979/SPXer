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

function tsToDate(ts) {
    return new Date(ts * 1000);
}

function formatTime(ts) {
    const d = tsToDate(ts);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
}

async function analyzeDay(db, dateStr) {
    const filePath = path.join(dataDir, `${dateStr}.parquet`);
    
    if (!fs.existsSync(filePath)) {
        return {
            Date: dateStr,
            Day: getDayName(dateStr),
            Direction: 'NO DATA',
            'Daily O-H-L-C': '',
            '15m Channel': '',
            '1h Channel': '',
            'Afternoon Skew': 'N/A',
            'Afternoon Price': '',
            'Signal': 'NO',
            'Reason': 'File not found'
        };
    }
    
    try {
        // Get 1m bars
        const query1m = `
            SELECT ts, open, high, low, close
            FROM '${filePath}'
            WHERE timeframe = '1m'
            ORDER BY ts
        `;
        
        const result1m = await db.all(query1m);
        
        if (!result1m || result1m.length === 0) {
            // Try 10m if 1m not available
            const query10m = `SELECT ts, open, high, low, close FROM '${filePath}' WHERE timeframe = '10m' ORDER BY ts`;
            const result10m = await db.all(query10m);
            
            if (!result10m || result10m.length === 0) {
                return {
                    Date: dateStr,
                    Day: getDayName(dateStr),
                    Direction: 'EMPTY',
                    'Daily O-H-L-C': '',
                    '15m Channel': '',
                    '1h Channel': '',
                    'Afternoon Skew': 'N/A',
                    'Afternoon Price': '',
                    'Signal': 'NO',
                    'Reason': 'No 1m or 10m data'
                };
            }
            
            return analyzeData(dateStr, result10m, '10m');
        }
        
        return analyzeData(dateStr, result1m, '1m');
        
    } catch (err) {
        return {
            Date: dateStr,
            Day: getDayName(dateStr),
            Direction: 'ERROR',
            'Daily O-H-L-C': '',
            '15m Channel': '',
            '1h Channel': '',
            'Afternoon Skew': '',
            'Afternoon Price': '',
            'Signal': 'ERROR',
            'Reason': err.message.substring(0, 50)
        };
    }
}

function analyzeData(dateStr, result, timeframe) {
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
    
    // Determine direction
    let direction = 'SIDEWAYS';
    const closeVsOpen = dailyClose - dailyOpen;
    if (dailyClose > dailyOpen + dailyRange * 0.02) {
        direction = 'UPTREND';
    } else if (dailyClose < dailyOpen - dailyRange * 0.02) {
        direction = 'DOWNTREND';
    }
    
    // Get candles before 15:50 ET (19:50 UTC, which is 20:50 UTC in EDT = -4)
    // Actually 15:50 ET = 19:50 UTC (EDT is UTC-4)
    const cutoffTs = Math.floor(new Date(dateStr + 'T19:50:00Z').getTime() / 1000);
    const beforeClose = result.filter(r => r.ts <= cutoffTs);
    
    // Get last 10 candles before close
    let ch15m = 'N/A';
    let ch1h = 'N/A';
    
    if (beforeClose.length >= 10) {
        const last10 = beforeClose.slice(-10);
        const last10Highs = last10.map(r => parseFloat(r.high));
        const last10Lows = last10.map(r => parseFloat(r.low));
        const ch15mHigh = Math.max(...last10Highs);
        const ch15mLow = Math.min(...last10Lows);
        ch15m = `${ch15mLow.toFixed(0)}-${ch15mHigh.toFixed(0)}`;
    }
    
    // Daily range string
    const dailyRangeStr = `O:${dailyOpen.toFixed(0)} H:${dailyHigh.toFixed(0)} L:${dailyLow.toFixed(0)} C:${dailyClose.toFixed(0)}`;
    
    // Afternoon window: 14:45-15:50 ET (18:45-19:50 UTC)
    const windowStartTs = Math.floor(new Date(dateStr + 'T18:45:00Z').getTime() / 1000);
    const windowEndTs = Math.floor(new Date(dateStr + 'T19:50:00Z').getTime() / 1000);
    const windowCandles = result.filter(r => r.ts >= windowStartTs && r.ts <= windowEndTs);
    
    let afternoonPrice = 'N/A';
    let afternoonMove = 0;
    
    if (windowCandles.length > 0) {
        const windowHigh = Math.max(...windowCandles.map(r => parseFloat(r.high)));
        const windowLow = Math.min(...windowCandles.map(r => parseFloat(r.low)));
        const windowClose = parseFloat(windowCandles[windowCandles.length - 1].close);
        const windowOpen = parseFloat(windowCandles[0].open);
        
        afternoonMove = windowClose - windowOpen;
        afternoonPrice = `L:${windowLow.toFixed(0)} H:${windowHigh.toFixed(0)} C:${windowClose.toFixed(0)}`;
    }
    
    // Signal detection: for now just check if daily range is significant
    // and there's meaningful afternoon movement
    let signal = 'NO';
    let reason = 'Low volatility';
    
    if (dailyRange > 25 && Math.abs(afternoonMove) > 5) {
        signal = 'MAYBE';
        reason = `Range=${dailyRange.toFixed(0)}pt, AftMove=${afternoonMove.toFixed(0)}pt`;
    } else if (dailyRange > 25) {
        signal = 'MAYBE';
        reason = `High Range=${dailyRange.toFixed(0)}pt`;
    } else {
        reason = `Range=${dailyRange.toFixed(0)}pt`;
    }
    
    return {
        Date: dateStr,
        Day: getDayName(dateStr),
        Direction: direction,
        'Daily O-H-L-C': dailyRangeStr,
        '15m Channel': ch15m,
        '1h Channel': ch1h,
        'Afternoon': afternoonPrice,
        'Signal': signal,
        'Reason': reason,
        'Candles': result.length
    };
}

async function main() {
    const db = await DuckDB.Database.create(':memory:');
    
    console.log('\n' + '='.repeat(160));
    console.log('MAY 2026 TRADING DAY ANALYSIS - SPX 0DTE');
    console.log('='.repeat(160));
    console.log('');
    
    const results = [];
    
    for (const date of may2026Dates) {
        const dayResult = await analyzeDay(db, date);
        results.push(dayResult);
    }
    
    // Print table
    console.log('Date       | Day       | Direction | Daily O-H-L-C              | 15m Channel | Signal | Reason');
    console.log('-'.repeat(160));
    
    for (const r of results) {
        const dirStr = r.Direction.padEnd(9);
        const dayStr = r.Day.padEnd(9);
        const range = r['Daily O-H-L-C'].padEnd(26);
        const ch15m = (r['15m Channel'] || 'N/A').padEnd(11);
        const sig = r.Signal.padEnd(6);
        const reason = r.Reason || '';
        
        console.log(`${r.Date} | ${dayStr} | ${dirStr} | ${range} | ${ch15m} | ${sig} | ${reason.substring(0, 80)}`);
        if (r.Afternoon && r.Afternoon !== 'N/A') {
            console.log(`           |           |           | Afternoon: ${r.Afternoon}`);
        }
    }
    
    console.log('\n' + '='.repeat(160));
    console.log('SUMMARY\n');
    
    const validResults = results.filter(r => 
        r.Direction !== 'NO DATA' && r.Direction !== 'ERROR' && r.Direction !== 'EMPTY'
    );
    
    const uptrends = validResults.filter(r => r.Direction === 'UPTREND').length;
    const downtrends = validResults.filter(r => r.Direction === 'DOWNTREND').length;
    const sideways = validResults.filter(r => r.Direction === 'SIDEWAYS').length;
    const signals = validResults.filter(r => r.Signal === 'MAYBE').length;
    
    console.log(`Trading days analyzed: ${validResults.length}`);
    console.log(`  UPTREND: ${uptrends}`);
    console.log(`  DOWNTREND: ${downtrends}`);
    console.log(`  SIDEWAYS: ${sideways}`);
    console.log(`Signal opportunities (Range > 25pt): ${signals}`);
    console.log(`Signal rate: ${(signals/validResults.length*100).toFixed(1)}%`);
    console.log(`Missing data: ${results.length - validResults.length} days`);
    
    await db.close();
}

main().catch(console.error);

