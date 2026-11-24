#!/usr/bin/env node
/**
 * Which model picks Arlo's tools correctly?
 *
 *   node scripts/agent-eval.js [--models a,b,c] [--runs 2] [--delay-ms 3000]
 *
 * Asks each model every case in agent-eval-cases.json (synthetic requests, no
 * meeting text) `--runs` times and prints, per model: how often it picked the
 * right tool, how often the arguments were right, the median time, and what
 * failed. Only the named model is asked each time (no fallback), so a number
 * belongs to one model.
 *
 * This calls OpenRouter: it needs AI_ENABLED=true and OPENROUTER_API_KEY, and
 * tests only models in OPENROUTER_MODELS. The key is never printed. Free
 * models are rate limited per minute and per day: 53 cases x 2 runs is 106
 * requests per model, so name one or two models at a time with --models when
 * the daily limit is small. A model that is rate limited five times in a row
 * is stopped.
 *
 * A case: { kind, said, expectTool, expectArgs?, context? }
 *   expectTool  a tool name or 'none', or a list when more than one is right
 *   expectArgs  { <argument>: { equals?: string, includes?: string[], excludes?: string[] } },
 *               compared without regard to case; checked when a tool was picked
 *   context     lines of a made-up meeting. Not given to the model any more: the
 *               model that picks a tool gets the request alone, as on the server
 *               (services/agent/agent.js), so these lines cannot steer it
 */
const path = require('node:path');

const RATE_LIMIT_STOP = 5;

const lower = (value) => String(value).toLowerCase();

/** Whether one argument is what the case expects. */
function argumentMatches(value, rule) {
  if (typeof value !== 'string' || rule === null || typeof rule !== 'object') return false;
  const got = lower(value).trim();
  if (typeof rule.equals === 'string' && got !== lower(rule.equals).trim()) return false;
  if (Array.isArray(rule.includes) && !rule.includes.every((part) => got.includes(lower(part)))) return false;
  if (Array.isArray(rule.excludes) && rule.excludes.some((part) => got.includes(lower(part)))) return false;
  return true;
}

/**
 * Score one answer ({ tool, args } or { tool: 'none' }) against its case.
 * The arguments are checked only when the case names some and a right tool
 * (not 'none') was picked.
 */
function scoreCase(testCase, result) {
  const picked = result !== null && typeof result === 'object' && typeof result.tool === 'string' ? result.tool : null;
  const toolCorrect = picked !== null && [].concat(testCase.expectTool).includes(picked);
  const expectArgs = testCase.expectArgs;
  const argsChecked = toolCorrect && picked !== 'none' && expectArgs !== null && typeof expectArgs === 'object';
  const args = result !== null && typeof result === 'object' && result.args !== null && typeof result.args === 'object' ? result.args : {};
  const argsCorrect = argsChecked && Object.keys(expectArgs).every((key) => (
    // An argument of another tool the case allows is not asked about
    Object.prototype.hasOwnProperty.call(args, key) && argumentMatches(args[key], expectArgs[key])
  ));
  return { toolCorrect, argsChecked, argsCorrect };
}

const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** One model's numbers from its rows ({ toolCorrect, argsChecked, argsCorrect, ms } or { failed: code }). */
function summarize(rows) {
  const answered = rows.filter((row) => !row.failed);
  const checked = answered.filter((row) => row.argsChecked);
  const failures = {};
  for (const row of rows) {
    if (row.failed) failures[row.failed] = (failures[row.failed] || 0) + 1;
  }
  return {
    attempts: rows.length,
    answered: answered.length,
    toolPct: percent(answered.filter((row) => row.toolCorrect).length, answered.length),
    argsPct: percent(checked.filter((row) => row.argsCorrect).length, checked.length),
    medianMs: median(answered.map((row) => row.ms)),
    failures,
  };
}

/** --name value pairs. Returns null for anything it does not know. */
function readFlags(argv) {
  const flags = { models: null, runs: 2, delayMs: 3000 };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (typeof value !== 'string') return null;
    if (argv[i] === '--models') {
      flags.models = value.split(',').map((one) => one.trim()).filter(Boolean);
    } else if (argv[i] === '--runs' && /^[1-5]$/.test(value)) {
      flags.runs = Number(value);
    } else if (argv[i] === '--delay-ms' && /^\d{1,5}$/.test(value)) {
      flags.delayMs = Number(value);
    } else {
      return null;
    }
  }
  return flags;
}

const cell = (value, width) => String(value).padEnd(width);
const shown = (value, unit = '') => (value === null ? '-' : `${value}${unit}`);
/** A failure code as a short word: never an error's message. */
const codeOf = (error) => (error && typeof error.code === 'string' && /^[a-z_]{1,30}$/.test(error.code) ? error.code : 'error');

/**
 * Run the evaluation. Everything it touches is passed in, so tests run it
 * without the network. Returns the process exit code.
 */
async function main({
  argv, config, cases, chooseTool, tools, validateToolCall, log, wait, now = Date.now,
}) {
  const flags = readFlags(argv);
  if (!flags) {
    log('Usage: node scripts/agent-eval.js [--models a,b,c] [--runs 1-5] [--delay-ms 0-99999]');
    return 1;
  }
  if (config.aiEnabled !== true) {
    log('AI is disabled: set AI_ENABLED=true to run this.');
    return 1;
  }
  if (!config.openrouterApiKey) {
    log('No OpenRouter key: set OPENROUTER_API_KEY to run this (the key is never printed).');
    return 1;
  }
  const allowed = Array.isArray(config.allowedOpenRouterModels) ? config.allowedOpenRouterModels : [];
  const models = flags.models ? flags.models.filter((model) => allowed.includes(model)) : [...allowed];
  if (models.length === 0) {
    log('No model to test: --models must name models listed in OPENROUTER_MODELS (free models only).');
    return 1;
  }

  log(`${cases.length} cases x ${flags.runs} run(s) for ${models.length} model(s), ${flags.delayMs} ms between requests.`);
  const results = [];
  for (const model of models) {
    const rows = [];
    const missed = [];
    let limitedInARow = 0;
    let stopped = false;
    for (let run = 0; run < flags.runs && !stopped; run += 1) {
      for (let index = 0; index < cases.length && !stopped; index += 1) {
        const testCase = cases[index];
        const started = now();
        try {
          let result = await chooseTool({
            request: testCase.said, tools, model, fallback: false,
          });
          // As the server will: a call that fails the tool table's check is no call
          if (result && result.tool !== 'none' && validateToolCall) {
            const checked = validateToolCall(result.tool, result.args);
            result = checked.ok ? { tool: result.tool, args: checked.args } : { tool: 'none' };
          }
          const score = scoreCase(testCase, result);
          rows.push({ ...score, ms: now() - started });
          if (!score.toolCorrect || (score.argsChecked && !score.argsCorrect)) {
            missed.push(`#${index + 1} ${score.toolCorrect ? 'arguments' : `picked ${result && typeof result.tool === 'string' ? result.tool : 'nothing'}`}`);
          }
          limitedInARow = 0;
        } catch (error) {
          const code = codeOf(error);
          rows.push({ failed: code });
          limitedInARow = code === 'rate_limited' ? limitedInARow + 1 : 0;
          if (limitedInARow >= RATE_LIMIT_STOP) {
            stopped = true;
            log(`${model}: rate limited ${RATE_LIMIT_STOP} times in a row, stopped after ${rows.length} request(s). Try it again later, alone, with --models.`);
          }
        }
        if (!stopped) await wait(flags.delayMs);
      }
    }
    results.push({ model, summary: summarize(rows), missed });
  }

  const width = Math.max(5, ...models.map((model) => model.length)) + 2;
  log('');
  log(`${cell('model', width)}${cell('tool', 9)}${cell('args', 9)}${cell('median', 10)}${cell('answered', 10)}failures`);
  for (const { model, summary } of results) {
    const failures = Object.entries(summary.failures).map(([code, count]) => `${code}: ${count}`).join(', ') || 'none';
    log(`${cell(model, width)}${cell(shown(summary.toolPct, '%'), 9)}${cell(shown(summary.argsPct, '%'), 9)}${cell(shown(summary.medianMs, ' ms'), 10)}${cell(`${summary.answered}/${summary.attempts}`, 10)}${failures}`);
  }
  for (const { model, missed } of results) {
    if (missed.length > 0) log(`\n${model} missed (case number in agent-eval-cases.json): ${missed.join('; ')}`);
  }
  log('\nPick the model with the best tool % at a median under 4000 ms and set AGENT_MODEL to it. Under 85%: decide before going on.');
  return 0;
}

module.exports = { main, scoreCase, summarize, readFlags };

if (require.main === module) {
  /* eslint-disable global-require */
  const config = require('../src/config');
  const { chooseTool } = require('../src/services/openrouter');
  const { listTools, validateToolCall } = require('../src/services/agent/tools');
  const cases = require(path.join(__dirname, 'agent-eval-cases.json'));
  /* eslint-enable global-require */
  // The client's own failure lines (model and status) would bury the table
  console.error = () => {};
  console.warn = () => {};
  main({
    argv: process.argv.slice(2),
    config,
    cases,
    chooseTool,
    tools: listTools(),
    validateToolCall,
    log: (line) => process.stdout.write(`${line}\n`),
    wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  }).then((code) => process.exit(code), () => {
    process.stdout.write('The evaluation stopped on an unexpected error.\n');
    process.exit(1);
  });
}
