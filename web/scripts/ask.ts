/**
 * Ask the analyst from the terminal, through the same handler as POST /api/analyst.
 *
 *   npm run ask -- "When did the fire reach Lake Ave?"
 *   npm run ask -- --report
 *   npm run ask -- --fire palisades --json "How many structures burned near Altadena?"
 */
import {handleAnalyst} from '../api/analyst.js';
import type {AnalystResponse} from '../api/_lib/types.js';
import {modelApiKey, NO_KEY_MESSAGE, WEB_ROOT} from './_env.js';

function parseArgs(argv: string[]) {
  const opts = {fire: 'eaton', mode: 'answer' as 'answer' | 'report', json: false, question: ''};
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report') opts.mode = 'report';
    else if (a === '--json') opts.json = true;
    else if (a === '--fire') opts.fire = argv[++i] ?? opts.fire;
    else if (a.startsWith('--fire=')) opts.fire = a.slice(7);
    else words.push(a);
  }
  opts.question = words.join(' ').trim() || (opts.mode === 'report' ? 'Draft the incident report.' : '');
  return opts;
}

function printAnswer(r: AnalystResponse): void {
  if (!r.paragraphs.length) console.log(r.note ?? '(No paragraph survived citation and guardrail checks.)');
  for (const p of r.paragraphs) {
    console.log(`\n${p.text}`);
    for (const c of p.cites) {
      const where = c.lon !== undefined && c.lat !== undefined ? ` @ ${c.lon.toFixed(5)}, ${c.lat.toFixed(5)}` : '';
      console.log(`  [${c.id}] ${c.layer}${c.t ? ` ${c.t}` : ''}${where} · ${c.label}`);
    }
  }
  console.log(`\ntools: ${r.tool_calls.map(t => `${t.name}(${JSON.stringify(t.args)})`).join(', ') || 'none'}`);
  console.log(`dropped: ${r.dropped.uncited} uncited, ${r.dropped.guardrail} guardrail, ${r.dropped.ungrounded} ungrounded · model ${r.model}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.question) {
    console.error('Usage: npm run ask -- "your question" [--report] [--fire eaton] [--json]');
    process.exit(64);
  }
  const key = modelApiKey();
  if (!key) {
    console.error(NO_KEY_MESSAGE);
    process.exit(2);
  }
  const out = await handleAnalyst({question: opts.question, fire: opts.fire, mode: opts.mode}, {MODEL_API_KEY: key}, WEB_ROOT);
  if (out.status !== 200) {
    console.error(`HTTP ${out.status}: ${(out.body as {error?: string}).error ?? JSON.stringify(out.body)}`);
    process.exit(1);
  }
  if (opts.json) console.log(JSON.stringify(out.body, null, 2));
  else printAnswer(out.body as AnalystResponse);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
