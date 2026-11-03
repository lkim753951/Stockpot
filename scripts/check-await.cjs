// Finds promises nobody is waiting for. Run with: node scripts/check-await.cjs
// It uses the type checker, so it sees through renamed imports and helpers, which a text search can't.
// A call that gives a promise must be awaited, returned, given a .catch, or passed to Promise.all.
// `void` doesn't count, and a promise kept in a variable must be settled somewhere.
const { execSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const ts = require(path.join(execSync('npm root -g').toString().trim(), 'typescript'))
const root = path.resolve(process.argv[2] ?? '.')
const FOLDERS = ['api', 'server', 'shared', 'scripts', 'test']

const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name)
  return entry.isDirectory() ? list(full) : /\.ts$/.test(entry.name) ? [full] : []
}) : [])
const files = FOLDERS.flatMap((folder) => list(path.join(root, folder)))

const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true, noEmit: true, strict: true, skipLibCheck: true, resolveJsonModule: true,
  types: ['node'], typeRoots: [path.join(root, 'node_modules/@types')], lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
})
const checker = program.getTypeChecker()
const problems = []
let promiseCalls = 0
let asyncFunctions = 0

const isPromise = (type) => {
  if (type.isUnion()) return type.types.some(isPromise)
  return !!type.getProperty('then') && !!type.getProperty('catch')
}

/** Steps out through wrappers that change nothing about the promise. */
function outermost(node) {
  let at = node
  while (ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent) || ts.isConditionalExpression(at.parent) || (ts.isBinaryExpression(at.parent) && at.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) at = at.parent
  return at
}

const chained = (node) => {
  const at = outermost(node)
  return ts.isPropertyAccessExpression(at.parent) && at.parent.expression === at && ts.isCallExpression(at.parent.parent) && at.parent.parent.expression === at.parent ? at.parent.name.text : null
}

const isPromiseCombinator = (call) => ts.isCallExpression(call) && /^Promise\.(all|allSettled|race|any)$/.test(call.expression.getText())

/** Inside Promise.all, directly, in a list, or as what a .map callback hands back. */
function gathered(node) {
  let at = node
  while (at.parent) {
    const parent = at.parent
    if (isPromiseCombinator(parent)) return true
    if (ts.isArrayLiteralExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isSpreadElement(parent) || ts.isConditionalExpression(parent)) { at = parent; continue }
    if (ts.isCallExpression(parent) && parent.arguments.includes(at) && ts.isPropertyAccessExpression(parent.expression) && /^(map|flatMap)$/.test(parent.expression.name.text)) { at = parent; continue }
    if (ts.isCallExpression(parent) && parent.expression.getText().startsWith('Array.from')) { at = parent; continue }
    return false
  }
  return false
}

const leavesFunction = (node) => {
  const at = outermost(node)
  return ts.isReturnStatement(at.parent) || (ts.isArrowFunction(at.parent) && at.parent.body === at)
}

/** A promise kept in a variable or a property is fine if the file goes on to settle it. */
function settledLater(node, sourceText) {
  const at = outermost(node)
  const parent = at.parent
  let name = null
  if (ts.isVariableDeclaration(parent) && parent.initializer === at) name = parent.name.getText()
  else if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(parent.operatorToken.kind) && parent.right === at) name = parent.left.getText()
  else if (ts.isPropertyDeclaration(parent) && parent.initializer === at) name = `this.${parent.name.getText()}`
  // Kept in a list to be gathered: receiving.push(work) and later Promise.all(receiving).
  else if (ts.isCallExpression(parent) && parent.arguments.includes(at) && ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === 'push') name = parent.expression.expression.getText()
  // Stored in a map of queues, each one chained on by the next.
  else if (ts.isCallExpression(parent) && parent.arguments.includes(at) && ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === 'set') name = parent.expression.expression.getText().concat('.get')
  if (!name) return false
  // Remembered and handed back in one go: const pool = () => (made ??= open()).
  if (ts.isBinaryExpression(parent) && leavesFunction(parent)) return true
  const words = name.replace(/[.$]/g, '\\$&')
  return new RegExp(`await ${words}\\b|\\b${words}\\(?[^\\n]{0,30}\\)?\\.(then|catch)\\(|Promise\\.all\\(${words}\\b|return ${words}\\b`).test(sourceText)
}

const CALLBACK_ONLY = /^(setTimeout|setInterval|setImmediate|queueMicrotask)$|\.(on|once|addListener|forEach)$/

function report(sf, node, why) {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  problems.push(`${path.relative(root, sf.fileName)}:${line + 1} ${why}: ${node.getText(sf).replace(/\s+/g, ' ').slice(0, 90)}`)
}

for (const sf of program.getSourceFiles()) {
  if (!files.includes(sf.fileName)) continue
  const text = sf.getFullText()
  const visit = (node) => {
    ts.forEachChild(node, visit)
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      asyncFunctions += 1
      const parent = node.parent
      if (ts.isCallExpression(parent) && parent.arguments.includes(node) && CALLBACK_ONLY.test(parent.expression.getText(sf))) report(sf, parent, 'async callback that nothing waits for')
    }
    if (!ts.isCallExpression(node) || !isPromise(checker.getTypeAtLocation(node))) return
    // node:test keeps track of its own tests.
    if (ts.isIdentifier(node.expression) && ['test', 'before', 'after'].includes(node.expression.text)) return
    promiseCalls += 1
    // Already settled, so there's nothing to wait for.
    if (node.expression.getText() === 'Promise.resolve') return
    // assert.rejects waits for what it's given.
    if (ts.isCallExpression(node.parent) && node.parent.expression.getText() === 'assert.rejects') return
    // A .catch on the end means a rejection has somewhere to go, whatever happens to the result.
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch') return
    const next = chained(node)
    if (next === 'then' || next === 'finally') return // judged by the call on the end of the chain
    if (next === 'catch') return
    if (ts.isAwaitExpression(node.parent) || leavesFunction(node) || gathered(node) || settledLater(node, text)) return
    if (ts.isAwaitExpression(outermost(node).parent)) return
    report(sf, node, ts.isVoidExpression(node.parent) ? 'void hides a rejection' : 'promise not awaited')
  }
  visit(sf)
}

console.log(`Checked ${files.length} files with TypeScript ${ts.version}: ${asyncFunctions} async functions, ${promiseCalls} calls that give a promise.`)
console.log(problems.length ? problems.join('\n') : 'Nothing left unawaited.')
process.exit(problems.length ? 1 : 0)
