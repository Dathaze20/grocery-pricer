import { describe, expect, it } from 'vitest';
import { AiResponseParser, extractFirstJsonObject, parseJsonObject } from '../ai-parse';
import { OrderImageType } from '../ai-types';

describe('extractFirstJsonObject', () => {
  it('finds the object inside a markdown fence the model was asked not to use', () => {
    const raw = '```json\n{"items":[]}\n```';
    expect(extractFirstJsonObject(raw)).toBe('{"items":[]}');
  });

  it('is not fooled by a brace inside a product name', () => {
    // A naive scan for the first "}" truncates this into invalid JSON.
    const raw = '{"items":[{"rawName":"BRAND {SPECIAL} 8Z","casePrice":"4.99"}]}';
    expect(extractFirstJsonObject(raw)).toBe(raw);
  });

  it('is not fooled by a quote or a brace inside an escaped string', () => {
    const raw = '{"items":[{"rawName":"6\\" PIE }{","casePrice":"4.99"}]}';
    expect(parseJsonObject(raw)).not.toBeNull();
  });

  it('returns nothing for a reply that was cut off mid-object', () => {
    expect(extractFirstJsonObject('{"items":[{"rawName":"CORN OIL"')).toBeNull();
  });

  it('returns nothing for prose', () => {
    expect(extractFirstJsonObject('I could not read that receipt, sorry.')).toBeNull();
    expect(extractFirstJsonObject('')).toBeNull();
    expect(extractFirstJsonObject(null)).toBeNull();
  });
});

describe('orderExtraction', () => {
  it('reads a well-formed reply', () => {
    const result = AiResponseParser.orderExtraction(
      '{"supplier":"JETRO","items":[{"rawName":"CORN OIL","casePrice":"30.00","unitsPerCase":6,' +
        '"sourcePhotoIds":[1],"sourceText":["CORN OIL 30.00"],"confidence":0.9}],"warnings":["blurry"]}',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.supplier).toBe('JETRO');
    expect(result.value.items[0]!.casePrice).toBe('30.00');
    expect(result.value.warnings).toEqual(['blurry']);
  });

  it('will not read a reply with no items array as an empty order', () => {
    // "Nothing on the receipt" and "the reply was broken" must not look the same.
    const result = AiResponseParser.orderExtraction('{"supplier":"JETRO"}');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe('malformedResponse');
  });

  it('reads an empty items array as an empty order', () => {
    const result = AiResponseParser.orderExtraction('{"items":[]}');
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.items).toHaveLength(0);
  });

  it('keeps a price the model sent as a number, as text', () => {
    const result = AiResponseParser.orderExtraction(
      '{"items":[{"rawName":"CORN OIL","casePrice":30,"unitsPerCase":6,"sourcePhotoIds":[],"sourceText":[],"confidence":0.5}]}',
    );
    // Whatever arrives, only Money is allowed to turn it into an amount.
    expect(result.ok && typeof result.value.items[0]!.casePrice).not.toBe('number');
  });

  it('treats a model that forgot to score itself as unsure, not as certain', () => {
    const result = AiResponseParser.orderExtraction(
      '{"items":[{"rawName":"CORN OIL","casePrice":"30.00","unitsPerCase":6,"sourcePhotoIds":[],"sourceText":[]}]}',
    );
    expect(result.ok && result.value.items[0]!.confidence).toBe(0);
  });

  it('reads an empty discount object as no discount', () => {
    const result = AiResponseParser.orderExtraction(
      '{"items":[{"rawName":"CORN OIL","casePrice":"30.00","unitsPerCase":6,"discount":{},' +
        '"sourcePhotoIds":[],"sourceText":[],"confidence":0.8}]}',
    );
    expect(result.ok && result.value.items[0]!.discount).toBeNull();
  });

  it('survives fields of entirely the wrong type', () => {
    const result = AiResponseParser.orderExtraction(
      '{"supplier":42,"items":[{"rawName":["CORN OIL"],"unitsPerCase":"six","sourcePhotoIds":"1",' +
        '"sourceText":null,"confidence":"high"}],"warnings":{"a":1}}',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A scalar of the wrong type is read as its text - a model that answers 30 instead of "30"
    // for a price is being sloppy, not wrong, and Money still decides whether it is an amount.
    expect(result.value.supplier).toBe('42');
    // A field that arrived as an array or an object has no sensible reading, so it is dropped.
    expect(result.value.items[0]!.rawName).toBeNull();
    expect(result.value.items[0]!.unitsPerCase).toBeNull();
    expect(result.value.items[0]!.confidence).toBe(0);
  });
});

describe('imageClassification', () => {
  it('reads a classification and treats an unknown label as UNKNOWN', () => {
    const result = AiResponseParser.imageClassification(
      '{"images":[{"photoId":1,"type":"RECEIPT","confidence":0.9},{"photoId":2,"type":"A PIGEON","confidence":0.2}]}',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.type).toBe(OrderImageType.RECEIPT);
    expect(result.value[1]!.type).toBe(OrderImageType.UNKNOWN);
  });

  it('drops a classification with no photo id to attach it to', () => {
    const result = AiResponseParser.imageClassification('{"images":[{"type":"RECEIPT"}]}');
    expect(result.ok && result.value).toHaveLength(0);
  });
});

describe('productIdentification', () => {
  it('falls back to reading order so "the second one" still means something', () => {
    const result = AiResponseParser.productIdentification(
      '{"products":[{"brand":"TIDE"},{"brand":"DOWNY"}]}',
    );
    expect(result.ok && result.value.products.map((p) => p.position)).toEqual([0, 1]);
  });

  it('drops a product with nothing identifying in it', () => {
    const result = AiResponseParser.productIdentification(
      '{"products":[{"brand":null,"productName":null,"upc":null,"size":"8 OZ"}]}',
    );
    expect(result.ok && result.value.products).toHaveLength(0);
  });
});

describe('caseCount', () => {
  it('reads a sighting with its hedge intact', () => {
    const result = AiResponseParser.caseCount(
      '{"sightings":[{"brand":"BUDWEISER","countedCases":7,"mayBeHidden":true,"confidence":0.8,"sourcePhotoIds":[1]}]}',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sightings[0]!.countedCases).toBe(7);
    expect(result.value.sightings[0]!.mayBeHidden).toBe(true);
  });

  it('assumes nothing is hidden only when the model actually said so', () => {
    const result = AiResponseParser.caseCount('{"sightings":[{"brand":"BUD","countedCases":2}]}');
    expect(result.ok && result.value.sightings[0]!.mayBeHidden).toBe(false);
    expect(result.ok && result.value.sightings[0]!.confidence).toBe(0);
  });

  it('drops an absurd or negative count rather than correcting it', () => {
    const result = AiResponseParser.caseCount(
      '{"sightings":[{"brand":"BUD","countedCases":-3},{"brand":"CORONA","countedCases":99999},' +
        '{"brand":"MODELO","countedCases":4}]}',
    );

    expect(result.ok && result.value.sightings).toHaveLength(1);
    expect(result.ok && result.value.sightings[0]!.brand).toBe('MODELO');
  });
});

describe('questionResolution', () => {
  const allowed = new Set([1, 2, 3]);

  it('drops an item id that was never offered to the model', () => {
    const result = AiResponseParser.questionResolution(
      '{"kind":"productMatches","itemIds":[2,404]}',
      allowed,
    );
    expect(result.ok && result.value.kind === 'productMatches' && result.value.itemIds).toEqual([2]);
  });

  it('becomes unresolved when every id it named was invented', () => {
    const result = AiResponseParser.questionResolution(
      '{"kind":"productMatches","itemIds":[404]}',
      allowed,
    );
    expect(result.ok && result.value.kind).toBe('unresolved');
  });

  it('refuses a price correction aimed at an unknown row', () => {
    const result = AiResponseParser.questionResolution(
      '{"kind":"priceCorrection","updates":[{"itemId":404,"retailPrice":"7.99"}]}',
      allowed,
    );
    // A hallucinated reference must never become a real price change.
    expect(result.ok && result.value.kind).toBe('unresolved');
  });

  it('keeps a dictated price as the text the shopkeeper said', () => {
    const result = AiResponseParser.questionResolution(
      '{"kind":"priceCorrection","updates":[{"itemId":1,"retailPrice":"7.99"}]}',
      allowed,
    );
    expect(result.ok && result.value.kind === 'priceCorrection' && result.value.updates[0]!.retailPrice).toBe(
      '7.99',
    );
  });

  it('treats an answer type it has never heard of as unresolved', () => {
    const result = AiResponseParser.questionResolution('{"kind":"placeAnOrder","itemIds":[1]}', allowed);
    expect(result.ok && result.value.kind).toBe('unresolved');
  });

  it('reports a reply with no kind at all as malformed', () => {
    const result = AiResponseParser.questionResolution('{"itemIds":[1]}', allowed);
    expect(result.ok).toBe(false);
  });

  it('will not accept a clarification with no question in it', () => {
    const result = AiResponseParser.questionResolution('{"kind":"clarification"}', allowed);
    expect(result.ok).toBe(false);
  });

  it('drops an incomplete profit question rather than answering at no price', () => {
    const result = AiResponseParser.questionResolution(
      '{"kind":"profitQuery","itemIds":[1]}',
      allowed,
    );
    expect(result.ok && result.value.kind).toBe('unresolved');
  });
});
