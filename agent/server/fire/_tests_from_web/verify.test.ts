import {describe, expect, it} from 'vitest';
import type {Cite} from '../_lib/types.js';
import {FireStore} from '../_lib/data.js';
import {createToolRunner} from '../_lib/tools.js';
import {containsAddress, mentionsCause, ungroundedNumbers, verifyAnswer} from '../_lib/verify.js';

const registry = new Map<string, Cite>([
  ['c1', {id: 'c1', layer: 'arrival', t: '2025-01-08T15:11:00Z', lon: -118.13072, lat: 34.20362, label: 'First burn on North Lake Avenue'}],
  ['c2', {id: 'c2', layer: 'weather', t: '2025-01-08T07:00:00Z', lon: -118.1, lat: 34.2, label: 'Wind'}]
]);

describe('citation verification', () => {
  it('keeps only cite ids a tool returned', () => {
    const v = verifyAnswer([{text: 'The fire reached North Lake Avenue at 7:11 AM PST on Jan 8.', cite_ids: ['c1', 'c99', 'C2']}], registry);
    expect(v.paragraphs).toHaveLength(1);
    expect(v.paragraphs[0].cites.map(c => c.id)).toEqual(['c1', 'c2']);
    expect(v.paragraphs[0].cites[0]).toEqual(registry.get('c1'));
    expect(v.audit).toEqual({proposed: 3, invalid: 1});
  });

  it('drops paragraphs left with no valid cite', () => {
    const v = verifyAnswer(
      [
        {text: 'Invented fact.', cite_ids: ['c42']},
        {text: 'No cites at all.', cite_ids: []},
        {text: 'Missing field.'},
        {text: 'Supported.', cite_ids: ['c2']}
      ],
      registry
    );
    expect(v.paragraphs.map(p => p.text)).toEqual(['Supported.']);
    expect(v.dropped).toEqual({uncited: 3, guardrail: 0, ungrounded: 0});
  });

  it('harvests inline [c1] markers into cites and removes them from the text', () => {
    const v = verifyAnswer([{text: 'Gusts reached 46 mph [c2]. Then it burned (c1, c7).', cite_ids: []}], registry);
    expect(v.paragraphs[0].text).toBe('Gusts reached 46 mph. Then it burned.');
    expect(v.paragraphs[0].cites.map(c => c.id)).toEqual(['c2', 'c1']);
    expect(v.audit.invalid).toBe(1);
  });

  it('ignores malformed final answers', () => {
    expect(verifyAnswer('not a list', registry).paragraphs).toEqual([]);
    expect(verifyAnswer([null, 3, {text: '', cite_ids: ['c1']}], registry).paragraphs).toEqual([]);
  });
});

describe('guardrails', () => {
  const dropped = [
    'The fire was caused by equipment failure.',
    'Investigators believe the cause of the fire is still unknown.',
    'It may have been sparked by a downed line.',
    'Southern California Edison equipment is under scrutiny.',
    'SCE has not commented.',
    'Some suspect power lines near the canyon.',
    'A transmission line runs above the ridge.',
    'There is no evidence of arson.',
    'The home at 1234 North Lake Avenue was destroyed.',
    'Damage was heavy at 2240 E Mendocino St.',
    'Firefighters were at 845 N 5th Ave by midnight.',
    'The fire was attributed to a utility.',
    'Officials blamed a failure near the canyon.',
    'An electrical short is suspected.',
    'A short-circuit started it.',
    'The fire originated from equipment near the tower.',
    'Nobody knows who is responsible for the fire.'
  ];
  const kept = [
    'Because gusts reached 46 mph, embers carried far.',
    'These are associations in observational data, not causal effects.',
    'By 7:10 PM North Lake Avenue had burned.',
    'On Jan 8, 2025 Lake Avenue was inside the perimeter.',
    'Within 500 m of Lake Ave, 686 structures were destroyed.',
    'The count includes 12 Utility Misc Structure outbuildings.',
    'The model estimate is not an investigated origin; the fire was reported at 6:18 PM PST.'
  ];

  it.each(dropped)('drops: %s', text => {
    const v = verifyAnswer([{text, cite_ids: ['c1']}], registry);
    expect(v.paragraphs).toHaveLength(0);
    expect(v.dropped).toEqual({uncited: 0, guardrail: 1, ungrounded: 0});
  });

  it.each(kept)('keeps: %s', text => {
    expect(mentionsCause(text) || containsAddress(text)).toBe(false);
    expect(verifyAnswer([{text, cite_ids: ['c1']}], registry).paragraphs).toHaveLength(1);
  });

  it('checks guardrails before citations, so a paragraph counts once', () => {
    const v = verifyAnswer([{text: 'Arson is suspected.', cite_ids: ['c404']}], registry);
    expect(v.dropped).toEqual({uncited: 0, guardrail: 1, ungrounded: 0});
  });
});

describe('number grounding', () => {
  const evidence = new Map<string, unknown>([
    ['c1', {result: {arrival: {t: '2025-01-08T15:11:00Z', t_local: 'Wed, Jan 8, 2025, 7:11 AM PST'}, destroyed: 686, destroyed_rate: 0.4412, area_acres: 14147.3}}],
    ['c2', {result: {gust_mph: 46.2, wind_mph: 22}}]
  ]);
  const grounding = {evidence, question: 'How many structures within 1000 m were destroyed?'};
  const grounded: [string, string[]][] = [
    ['The fire reached North Lake Avenue at 7:11 AM PST on Jan 8, 2025.', ['c1']],
    ['686 structures were destroyed, 44% of those inspected.', ['c1']],
    ['About 14,000 acres had burned.', ['c1']],
    ['Gusts reached 46 mph, with sustained wind of 22 mph.', ['c2']],
    ['Within 1000 m, 686 structures were destroyed.', ['c1']],
    ['Two perimeters and 3 stations agree.', ['c2']]
  ];
  const ungrounded: [string, string[]][] = [
    ['The fire reached North Lake Avenue at 7:40 AM PST.', ['c1']],
    ['Gusts reached 61 mph.', ['c2']],
    ['686 structures were destroyed.', ['c2']],
    ['About 52% were destroyed.', ['c1']],
    ['The fire burned 3,200 acres per hour.', ['c1', 'c2']]
  ];

  it.each(grounded)('keeps: %s', (text, ids) => {
    const v = verifyAnswer([{text, cite_ids: ids}], registry, grounding);
    expect(ungroundedNumbers(text, ids.map(id => registry.get(id)!), grounding)).toEqual([]);
    expect(v.paragraphs).toHaveLength(1);
  });

  it.each(ungrounded)('drops: %s', (text, ids) => {
    const v = verifyAnswer([{text, cite_ids: ids}], registry, grounding);
    expect(v.paragraphs).toHaveLength(0);
    expect(v.dropped).toEqual({uncited: 0, guardrail: 0, ungrounded: 1});
  });

  it('records the tool output behind every cite it registers', () => {
    const runner = createToolRunner(new FireStore('eaton'));
    const out = JSON.parse(runner.run('weather_at', JSON.stringify({t: '2025-01-08T07:00:00Z'})).content);
    expect(out.cites.length).toBeGreaterThan(0);
    for (const c of out.cites) expect(runner.evidence.get(c.id)).toMatchObject({result: out.result});
    const gust = out.result.gust_mph ?? out.result.weather?.gust_mph;
    if (typeof gust === 'number') {
      const text = `Gusts reached ${Math.round(gust)} mph.`;
      expect(ungroundedNumbers(text, out.cites, {evidence: runner.evidence})).toEqual([]);
    }
  });
});
