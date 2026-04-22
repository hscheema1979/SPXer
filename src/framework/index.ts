/**
 * Barrel export for the framework layer.
 *
 * Import surface:
 *   import { runAgent, validateAgentBoot, formatBootBanner } from 'src/framework';
 */
export {
  runAgent,
  validateAgentBoot,
  formatBootBanner,
} from './agent-runner';

export type {
  AgentRunnerOptions,
  AgentRunnerHandle,
  AgentContext,
} from './agent-runner';
