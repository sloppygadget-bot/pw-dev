// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { startPwDevServer } from '../packages/server/src/index.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const SKIPPED_DIRECTORIES = new Set(['.agent', '.git', 'node_modules']);
const errors = [];

function reportError(message) {
  errors.push(message);
}

function relative(filePath) {
  return path.relative(REPO_ROOT, filePath) || '.';
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    reportError(`${relative(filePath)}: invalid JSON (${error.message})`);
    return undefined;
  }
}

function validateOpenApiDocument(filePath, document) {
  if (!document) return;
  if (typeof document.openapi !== 'string') reportError(`${relative(filePath)}: missing openapi version`);
  if (!document.info?.title || !document.info?.version) {
    reportError(`${relative(filePath)}: info.title and info.version are required`);
  }
  if (!document.paths || typeof document.paths !== 'object' || Array.isArray(document.paths)) {
    reportError(`${relative(filePath)}: paths must be an object`);
    return;
  }

  const operationIds = new Set();
  for (const [apiPath, pathItem] of Object.entries(document.paths)) {
    if (!apiPath.startsWith('/')) reportError(`${relative(filePath)}: path must start with / (${apiPath})`);
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation?.operationId) {
        reportError(`${relative(filePath)}: ${method.toUpperCase()} ${apiPath} is missing operationId`);
      } else if (operationIds.has(operation.operationId)) {
        reportError(`${relative(filePath)}: duplicate operationId ${operation.operationId}`);
      } else {
        operationIds.add(operation.operationId);
      }
      if (!operation?.responses || typeof operation.responses !== 'object') {
        reportError(`${relative(filePath)}: ${method.toUpperCase()} ${apiPath} is missing responses`);
      }
    }
  }
}

function resolveOpenApiLink(url) {
  if (url === '/_pwdev/openapi.json') return path.join(REPO_ROOT, 'packages/server/openapi/root.json');
  if (url === '/_pwdev/openapi/proxies.json') return path.join(REPO_ROOT, 'packages/server/openapi/proxies/index.json');
  if (url.startsWith('/_pwdev/openapi/')) {
    return path.join(REPO_ROOT, 'packages/server/openapi', url.slice('/_pwdev/openapi/'.length));
  }
  if (url === '/_pwdev/delegates/proxy/openapi.json') {
    return path.join(REPO_ROOT, 'packages/proxy/openapi/root.json');
  }
  if (url.startsWith('/_pwdev/delegates/proxy/openapi/')) {
    return path.join(REPO_ROOT, 'packages/proxy/openapi', url.slice('/_pwdev/delegates/proxy/openapi/'.length));
  }
  if (url === '/_proxy/openapi.json') return path.join(REPO_ROOT, 'packages/proxy/openapi/root.json');
  if (url.startsWith('/_proxy/openapi/')) {
    return path.join(REPO_ROOT, 'packages/proxy/openapi', url.slice('/_proxy/openapi/'.length));
  }
  return undefined;
}

function validateOpenApiFiles(files) {
  const openApiFiles = files.filter((filePath) => filePath.includes(`${path.sep}openapi${path.sep}`) && filePath.endsWith('.json'));
  for (const filePath of openApiFiles) {
    const document = readJson(filePath);
    validateOpenApiDocument(filePath, document);
    for (const entry of document?.['x-pwdev-documents'] ?? []) {
      if (typeof entry.id !== 'string' || typeof entry.url !== 'string' || typeof entry.whenToUse !== 'string') {
        reportError(`${relative(filePath)}: each x-pwdev-documents entry requires id, url, and whenToUse`);
        continue;
      }
      const target = resolveOpenApiLink(entry.url);
      if (!target) reportError(`${relative(filePath)}: cannot resolve OpenAPI link ${entry.url}`);
      else if (!fs.existsSync(target)) reportError(`${relative(filePath)}: OpenAPI link ${entry.url} targets missing ${relative(target)}`);
    }
  }
  return openApiFiles.length;
}

function validateInstructionTemplates() {
  const instructionRoot = path.join(REPO_ROOT, 'packages/server/instructions');
  const expected = new Map([
    ['agent.md', new Set(['API_DOCUMENTS', 'API_ENDPOINTS', 'SERVER_URL'])],
    ['broker-delegate.md', new Set(['SERVER_URL'])],
    ['proxy-delegate.md', new Set(['SERVER_URL'])],
  ]);
  for (const [name, expectedPlaceholders] of expected) {
    const filePath = path.join(instructionRoot, name);
    if (!fs.existsSync(filePath)) {
      reportError(`${relative(filePath)}: missing instruction template`);
      continue;
    }
    const source = fs.readFileSync(filePath, 'utf8');
    const actual = new Set([...source.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((match) => match[1]));
    for (const placeholder of expectedPlaceholders) {
      if (!actual.has(placeholder)) reportError(`${relative(filePath)}: missing {{${placeholder}}}`);
    }
    for (const placeholder of actual) {
      if (!expectedPlaceholders.has(placeholder)) reportError(`${relative(filePath)}: unknown {{${placeholder}}}`);
    }
  }
  return expected.size;
}

function validateMarkdownLinks(files) {
  const markdownFiles = files.filter((filePath) => filePath.endsWith('.md'));
  for (const filePath of markdownFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      let target = match[1].trim().replace(/^<|>$/g, '').split(/\s+['"]/)[0];
      if (!target || target.startsWith('#') || target.includes('{{') || /^[a-z][a-z+.-]*:/i.test(target)) continue;
      target = decodeURIComponent(target.split('#')[0]);
      const resolved = path.resolve(path.dirname(filePath), target);
      if (!fs.existsSync(resolved)) reportError(`${relative(filePath)}: local link targets missing ${target}`);
    }
  }
  return markdownFiles.length;
}

function validateDocumentedNpmScripts(files) {
  const packageJson = readJson(path.join(REPO_ROOT, 'package.json'));
  const scripts = new Set(Object.keys(packageJson?.scripts ?? {}));
  for (const filePath of files.filter((candidate) => candidate.endsWith('.md'))) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const block of source.matchAll(/```(?:bash|sh)\s*\n([\s\S]*?)```/g)) {
      for (const command of block[1].matchAll(/^\s*(?:\$\s+)?npm run ([a-zA-Z0-9:_-]+)/gm)) {
        if (!scripts.has(command[1])) {
          reportError(`${relative(filePath)}: fenced command references missing root npm script ${command[1]}`);
        }
      }
    }
  }
}

function validateKnowledgeTerminology(files) {
  const textFiles = files.filter((filePath) => /\.(?:js|json|md|mjs)$/.test(filePath));
  for (const filePath of textFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    if (/task[- ]scoped/i.test(source)) {
      reportError(`${relative(filePath)}: use named session or lease-scoped traffic terminology`);
    }
  }
}

function openApiOperations(documents) {
  const operations = [];
  const seen = new Set();
  for (const document of documents) {
    for (const [apiPath, pathItem] of Object.entries(document.paths ?? {})) {
      for (const method of Object.keys(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;
        const key = `${method}:${apiPath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        operations.push({ method: method.toUpperCase(), path: apiPath });
      }
    }
  }
  return operations;
}

async function validateLiveKnowledge() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-dev-kb-'));
  const server = await startPwDevServer({ root, port: 0 });
  try {
    const instructionsResponse = await fetch(`${server.origin}/_pwdev/instructions`);
    if (!instructionsResponse.ok) {
      reportError(`live instructions returned HTTP ${instructionsResponse.status}`);
      return;
    }
    const instructions = await instructionsResponse.text();
    if (instructions.includes('{{')) reportError('live instructions contain an unresolved template placeholder');

    const rootResponse = await fetch(`${server.origin}/_pwdev/openapi.json`);
    const rootDocument = await rootResponse.json();
    const documents = [rootDocument];
    for (const entry of rootDocument['x-pwdev-documents'] ?? []) {
      const response = await fetch(`${server.origin}${entry.url}`);
      if (!response.ok) {
        reportError(`live OpenAPI document ${entry.url} returned HTTP ${response.status}`);
        continue;
      }
      documents.push(await response.json());
      if (!instructions.includes(`${server.origin}${entry.url}`)) {
        reportError(`live instructions do not link catalog document ${entry.url}`);
      }
    }
    for (const operation of openApiOperations(documents)) {
      const row = `| ${operation.method} | \`${operation.path}\` |`;
      if (!instructions.includes(row)) reportError(`live instructions omit generated operation ${operation.method} ${operation.path}`);
    }

    for (const delegate of ['broker', 'proxy']) {
      const response = await fetch(`${server.origin}/_pwdev/delegates/${delegate}/instructions`);
      const body = await response.text();
      if (!response.ok) reportError(`${delegate} delegate instructions returned HTTP ${response.status}`);
      if (body.includes('{{')) reportError(`${delegate} delegate instructions contain an unresolved placeholder`);
      if (!body.includes(server.origin)) reportError(`${delegate} delegate instructions omit the live server origin`);
    }
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const files = walk(REPO_ROOT);
const openApiCount = validateOpenApiFiles(files);
const templateCount = validateInstructionTemplates();
const markdownCount = validateMarkdownLinks(files);
validateDocumentedNpmScripts(files);
validateKnowledgeTerminology(files);
await validateLiveKnowledge();

if (errors.length) {
  console.error(`Knowledge base check failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Knowledge base checks passed (${openApiCount} OpenAPI documents, ${templateCount} templates, ${markdownCount} Markdown files).`);
}
