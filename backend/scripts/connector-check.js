#!/usr/bin/env node
/**
 * Can Arlo's GitHub connector use the MCP server it is configured for?
 *
 *   node scripts/connector-check.js        (in the backend container:
 *   docker-compose exec backend node scripts/connector-check.js)
 *
 * Connects with GITHUB_TOKEN to GITHUB_MCP_URL (GitHub's hosted MCP server
 * when not set), asks for the server's tool list and prints:
 * - whether the token and the repository are set (never their values),
 * - the names of the server's tools,
 * - for the issue tools, the names and types of their input fields,
 * - for each of Arlo's three tools, whether it would be offered.
 *
 * It calls no tool: nothing of a repository or an issue is read or printed.
 * The token is never printed. Exit code 0 when all three tools would be
 * offered, 1 otherwise.
 */
const path = require('node:path');

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const FIELD = /^[A-Za-z0-9_]{1,60}$/;
const WORD = /^[A-Za-z0-9_]{1,30}$/;
const JSON_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
const MAX_FIELDS = 60;
const MAX_VALUES = 12;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The type of a schema property in known words only: "string", "array of string", "number | null", "?". */
function typeWords(property) {
  if (!isPlainObject(property)) return '?';
  const types = (Array.isArray(property.type) ? property.type : [property.type]).filter((type) => JSON_TYPES.includes(type));
  if (types.length === 0) return '?';
  const words = types.join(' | ');
  if (types.includes('array') && isPlainObject(property.items)) {
    const inner = typeWords(property.items);
    return inner === '?' ? words : `${words} of ${inner.split(',')[0]}`;
  }
  return words;
}

/** The values a property allows, when they are plain words: " (one of: get, get_comments)". */
function allowedWords(property) {
  const values = isPlainObject(property) && Array.isArray(property.enum) ? property.enum : null;
  if (!values) return '';
  const words = values.filter((value) => typeof value === 'string' && WORD.test(value)).slice(0, MAX_VALUES);
  return words.length > 0 ? ` (one of: ${words.join(', ')}${values.length > words.length ? ', …' : ''})` : '';
}

/** The lines that describe one tool's input: field names, types, which are required. Never a description. */
function describe(tool) {
  const schema = isPlainObject(tool.inputSchema) ? tool.inputSchema : {};
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const out = [];
  for (const [field, property] of Object.entries(properties).slice(0, MAX_FIELDS)) {
    if (!FIELD.test(field)) continue;
    const of = isPlainObject(property) && isPlainObject(property.items) ? allowedWords(property.items) : allowedWords(property);
    out.push(`    ${field}: ${typeWords(property)}${required.includes(field) ? ', required' : ''}${of}`);
  }
  return out;
}

async function main({ print = console.log, fetch } = {}) {
  // eslint-disable-next-line global-require
  const config = require(path.join(__dirname, '..', 'src', 'config.js'));
  // eslint-disable-next-line global-require
  const { createMcpClient } = require(path.join(__dirname, '..', 'src', 'services', 'connectors', 'mcpClient.js'));
  // eslint-disable-next-line global-require
  const { checkTools, TOOL_NAMES } = require(path.join(__dirname, '..', 'src', 'services', 'connectors', 'github.js'));

  print(`GITHUB_TOKEN: ${config.githubToken ? 'set' : 'not set (or not accepted)'}`);
  print(`GITHUB_DEFAULT_REPO: ${config.githubRepo ? 'set' : 'not set (or not accepted)'}`);
  print(`MCP server: ${config.githubMcpUrl}`);
  if (!config.githubToken || !config.githubRepo) {
    print('The GitHub connector is not configured: it needs both. Nothing was called.');
    return 1;
  }

  const client = createMcpClient({
    url: config.githubMcpUrl, headers: { Authorization: `Bearer ${config.githubToken}` }, ...(fetch ? { fetch } : {}),
  });
  let tools;
  try {
    tools = await client.listTools();
  } catch (error) {
    const code = error && typeof error.code === 'string' && WORD.test(error.code) ? error.code : 'unreachable';
    print(`Could not read the server's tool list: ${code}.`);
    if (code === 'unauthorized') print('The server refused the token. Check that it has not expired and may be used with this server.');
    return 1;
  } finally {
    await client.close();
  }

  const names = tools.map((tool) => tool.name).filter((name) => NAME.test(name)).sort();
  print(`\nThe server's tools (${names.length}):`);
  print(names.length > 0 ? `  ${names.join(', ')}` : '  none');

  print('\nInput fields of the issue tools:');
  const issueTools = tools.filter((tool) => NAME.test(tool.name) && /issue/.test(tool.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (issueTools.length === 0) print('  no tool with "issue" in its name');
  for (const tool of issueTools) {
    print(`  ${tool.name}`);
    for (const one of describe(tool)) print(one);
  }

  const checked = checkTools(tools);
  print('\nArlo\'s tools:');
  let all = true;
  for (const name of TOOL_NAMES) {
    const { offered, mcpTool, reason } = checked[name];
    if (offered) {
      print(`  ${name}: offered (through ${mcpTool})`);
    } else {
      all = false;
      print(`  ${name}: NOT offered: ${mcpTool} ${reason === 'missing' ? 'is not in the server\'s tool list' : 'has other parameters than Arlo sends'}`);
    }
  }
  if (checked.github_list_issues.offered) print(`  list_issues takes "fields": ${checked.listFields ? 'yes' : 'no (a text filter looks through fewer issues)'}`);
  return all ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
    // Should a connection linger after close(), the script still ends
    setTimeout(() => process.exit(code), 2000).unref();
  }, () => {
    // Whatever went wrong, its message is not printed: it is not ours
    console.error('connector-check failed unexpectedly.');
    process.exitCode = 1;
  });
}

module.exports = { main, describe, typeWords };
