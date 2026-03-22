import * as readline from 'readline';
import { DEFAULT_CONFIG, STRATEGY_PRESETS, validateConfig } from './config';
import { listScannerPrompts } from './prompt-library';
import type { ReplayConfig } from './types';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(prompt, resolve);
  });
}

function printSection(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(60)}\n`);
}

function printChecklist(item: string, current?: string | boolean | number) {
  const value = current !== undefined ? ` [${current}]` : '';
  console.log(`  ☐ ${item}${value}`);
}

function printCurrent(config: ReplayConfig) {
  console.log('\n--- Current Configuration ---');
  console.log(`Date: ${config.date}`);
  console.log(`Strategy: ${config.strategy || 'custom'}`);
  console.log(`Scanners: ${config.scanners.enabled ? 'enabled' : 'disabled'}`);
  if (config.scanners.enabled) {
    console.log(`  - Models: ${config.scanners.models.join(', ')}`);
    console.log(`  - Prompt: ${config.scanners.promptId}`);
  }
  console.log(`Judge: ${config.judge.enabled ? config.judge.model : 'disabled'}`);
  console.log(`Escalation: ${JSON.stringify(config.escalation, null, 2).split('\n').join('\n  ')}`);
  console.log('');
}

async function selectDate(): Promise<string> {
  printSection('1. Select Trading Date');
  console.log('Available backtest dates: 2026-02-18 through 2026-03-19');
  console.log('Format: YYYY-MM-DD\n');

  const dateStr = await question('Enter date: ');
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) {
    console.log('Invalid date format. Using 2026-03-20 (default)');
    return '2026-03-20';
  }
  return dateStr;
}

async function selectStrategy(): Promise<string | undefined> {
  printSection('2. Select Strategy Preset');
  console.log('Presets available:');
  console.log('  1. aggressive   - high-confidence signals, aggressive position sizing');
  console.log('  2. conservative - only high-confidence escalations, tight stops');
  console.log('  3. balanced     - mix of signal types, moderate sizing');
  console.log('  4. custom       - build your own\n');

  const choice = await question('Enter choice (1-4): ');
  const presetMap: Record<string, string> = {
    '1': 'aggressive',
    '2': 'conservative',
    '3': 'balanced',
    '4': 'custom',
  };
  return presetMap[choice];
}

async function selectScanners(config: ReplayConfig): Promise<Partial<ReplayConfig>> {
  printSection('3. Scanner Configuration');
  console.log('Options:');
  console.log('  1. Disabled (deterministic signals only)');
  console.log('  2. Haiku only (fast, cheap)');
  console.log('  3. All scanners (Haiku, Kimi, GLM, MiniMax) - parallel');
  console.log('  4. Custom selection\n');

  const choice = await question('Enter choice (1-4): ');

  const scannerMap: Record<string, string[]> = {
    '1': [],
    '2': ['haiku'],
    '3': ['haiku', 'kimi', 'glm', 'minimax'],
    '4': [],
  };

  let models = scannerMap[choice] || [];

  if (choice === '4') {
    console.log('\nSelect scanners (comma-separated: haiku, kimi, glm, minimax):');
    const input = await question('> ');
    models = input.split(',').map(s => s.trim().toLowerCase());
  }

  const prompts = listScannerPrompts();
  console.log(`\nAvailable scanner prompts:`);
  prompts.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  const promptChoice = await question(`Select prompt (1-${prompts.length}): `);
  const promptId = prompts[parseInt(promptChoice) - 1] || prompts[0];

  return {
    scanners: {
      ...config.scanners,
      enabled: models.length > 0,
      models,
      promptId,
      minConfidenceToEscalate: models.length > 0 ? 0.5 : 0,
    },
  };
}

async function selectJudge(config: ReplayConfig): Promise<Partial<ReplayConfig>> {
  printSection('4. Judge Configuration');

  if (!config.scanners.enabled) {
    console.log('Scanners disabled — judge not needed for deterministic-only mode.\n');
    return { judge: { enabled: false, model: 'haiku' } };
  }

  console.log('Options:');
  console.log('  1. Disabled (only use scanner setups)');
  console.log('  2. Haiku (fast, good for tiebreaker)');
  console.log('  3. Sonnet (balanced, good formatting)');
  console.log('  4. Opus (deep reasoning, cautious)\n');

  const choice = await question('Enter choice (1-4): ');

  const judgeMap: Record<string, { enabled: boolean; model: string }> = {
    '1': { enabled: false, model: 'haiku' },
    '2': { enabled: true, model: 'haiku' },
    '3': { enabled: true, model: 'sonnet' },
    '4': { enabled: true, model: 'opus' },
  };

  return { judge: judgeMap[choice] || { enabled: false, model: 'haiku' } };
}

async function selectEscalation(config: ReplayConfig): Promise<Partial<ReplayConfig>> {
  printSection('5. Escalation Rules');
  console.log('When should trades escalate to judge?\n');
  console.log('Options:');
  console.log('  1. Signals only (deterministic signals → judge)');
  console.log('  2. Scanners only (scanner setups → judge)');
  console.log('  3. Either (signals OR scanners → judge)');
  console.log('  4. Both (signals AND scanners required)');
  console.log('  5. Custom agreement rules\n');

  const choice = await question('Enter choice (1-5): ');

  const escalationMap: Record<string, any> = {
    '1': { signalTriggersJudge: true, scannerTriggersJudge: false, requireScannerAgreement: false, requireSignalAgreement: false },
    '2': { signalTriggersJudge: false, scannerTriggersJudge: true, requireScannerAgreement: false, requireSignalAgreement: false },
    '3': { signalTriggersJudge: true, scannerTriggersJudge: true, requireScannerAgreement: false, requireSignalAgreement: false },
    '4': { signalTriggersJudge: true, scannerTriggersJudge: true, requireScannerAgreement: true, requireSignalAgreement: true },
  };

  let escalation = escalationMap[choice];

  if (choice === '5') {
    escalation = { ...config.escalation };
    const signals = await question('Signals trigger judge? (y/n): ');
    escalation.signalTriggersJudge = signals.toLowerCase() === 'y';
    const scanners = await question('Scanners trigger judge? (y/n): ');
    escalation.scannerTriggersJudge = scanners.toLowerCase() === 'y';
    const sigAgree = await question('Signal needs scanner agreement? (y/n): ');
    escalation.requireSignalAgreement = sigAgree.toLowerCase() === 'y';
    const scanAgree = await question('Scanner needs signal agreement? (y/n): ');
    escalation.requireScannerAgreement = scanAgree.toLowerCase() === 'y';
  }

  return { escalation };
}

async function selectSignalThresholds(config: ReplayConfig): Promise<Partial<ReplayConfig>> {
  printSection('6. Signal Thresholds');

  const rsiOversoldStr = await question(`RSI oversold threshold (default ${config.signals.rsiOversoldLevel}): `);
  const rsiOverboughtStr = await question(`RSI overbought threshold (default ${config.signals.rsiOverboughtLevel}): `);

  return {
    signals: {
      ...config.signals,
      rsiOversoldLevel: parseInt(rsiOversoldStr) || config.signals.rsiOversoldLevel,
      rsiOverboughtLevel: parseInt(rsiOverboughtStr) || config.signals.rsiOverboughtLevel,
    },
  };
}

async function selectPositioning(config: ReplayConfig): Promise<Partial<ReplayConfig>> {
  printSection('7. Position Sizing & Risk');

  const maxPosStr = await question(`Max open positions (default ${config.position.maxOpenPositions}): `);
  const maxRiskStr = await question(`Max risk per trade in $ (default ${config.position.maxRiskPerTrade}): `);
  const stopLossStr = await question(`Stop loss % (default ${config.position.stopLossPercent}): `);
  const takeProfitStr = await question(`Take profit multiplier (default ${config.position.takeProfitMultiplier}x risk): `);

  return {
    position: {
      ...config.position,
      maxOpenPositions: parseInt(maxPosStr) || config.position.maxOpenPositions,
      maxRiskPerTrade: parseInt(maxRiskStr) || config.position.maxRiskPerTrade,
      stopLossPercent: parseFloat(stopLossStr) || config.position.stopLossPercent,
      takeProfitMultiplier: parseFloat(takeProfitStr) || config.position.takeProfitMultiplier,
    },
  };
}

async function confirmAndSave(config: ReplayConfig): Promise<boolean> {
  printSection('Review Configuration');
  printCurrent(config);

  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.log('⚠️  Configuration has issues:');
    errors.forEach(e => console.log(`  - ${e}`));
    console.log('');
  }

  const confirm = await question('Save this configuration? (y/n): ');
  return confirm.toLowerCase() === 'y';
}

export async function interactiveConfigBuilder(): Promise<ReplayConfig> {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║         SPXer Replay Configuration Checklist               ║');
  console.log('║  Build a replay config step-by-step with guided prompts    ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  let config = { ...DEFAULT_CONFIG };

  try {
    // Step 1: Date
    const date = await selectDate();
    config.date = date;

    // Step 2: Strategy
    const strategy = await selectStrategy();
    if (strategy && strategy !== 'custom' && strategy in STRATEGY_PRESETS) {
      config = {
        ...config,
        ...STRATEGY_PRESETS[strategy as keyof typeof STRATEGY_PRESETS],
        strategy,
      };
    }

    // Step 3: Scanners
    const scannerConfig = await selectScanners(config);
    config = { ...config, ...scannerConfig };

    // Step 4: Judge
    const judgeConfig = await selectJudge(config);
    config = { ...config, ...judgeConfig };

    // Step 5: Escalation
    const escalationConfig = await selectEscalation(config);
    config = { ...config, ...escalationConfig };

    // Step 6: Thresholds
    const thresholdConfig = await selectSignalThresholds(config);
    config = { ...config, ...thresholdConfig };

    // Step 7: Positioning
    const posConfig = await selectPositioning(config);
    config = { ...config, ...posConfig };

    // Final review & confirmation
    const saved = await confirmAndSave(config);

    if (!saved) {
      console.log('\nConfiguration not saved.');
      rl.close();
      process.exit(0);
    }

    console.log('\n✅ Configuration ready!\n');
    return config;
  } finally {
    rl.close();
  }
}
