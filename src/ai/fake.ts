import type {
  AiCaseCount,
  AiError,
  AiOrderExtraction,
  AiResult,
  OrderQuestionResolution,
  ProductIdentification,
} from '../core/ai-types';
import { aiFail, aiOk } from '../core/ai-types';
import { OrderImageType } from '../core/ai-types';
import type { AiProvider, IdentifiedImage, ImageClassification } from './provider';
import type { QuestionItemSummary } from './prompts';

/**
 * A provider that answers from a script instead of from Google.
 *
 * Every test in this repository runs against this. No test needs a key, and no test can spend a
 * user's free quota. Queue a canned answer per call, or a canned failure, and assert on what the
 * deterministic half of the app does with it.
 */
export class FakeAiProvider implements AiProvider {
  readonly name = 'Fake';
  readonly calls: string[] = [];

  private extractions: Array<AiResult<AiOrderExtraction>> = [];
  private classifications: Array<AiResult<readonly ImageClassification[]>> = [];
  private identifications: Array<AiResult<ProductIdentification>> = [];
  private counts: Array<AiResult<AiCaseCount>> = [];
  private resolutions: Array<AiResult<OrderQuestionResolution>> = [];

  queueExtraction(value: AiOrderExtraction): this {
    this.extractions.push(aiOk(value));
    return this;
  }

  queueClassification(value: readonly ImageClassification[]): this {
    this.classifications.push(aiOk(value));
    return this;
  }

  queueIdentification(value: ProductIdentification): this {
    this.identifications.push(aiOk(value));
    return this;
  }

  queueCaseCount(value: AiCaseCount): this {
    this.counts.push(aiOk(value));
    return this;
  }

  queueResolution(value: OrderQuestionResolution): this {
    this.resolutions.push(aiOk(value));
    return this;
  }

  /** Makes the next call of every kind fail, so error handling can be tested directly. */
  queueFailure(error: AiError): this {
    this.extractions.push(aiFail(error));
    this.classifications.push(aiFail(error));
    this.identifications.push(aiFail(error));
    this.counts.push(aiFail(error));
    this.resolutions.push(aiFail(error));
    return this;
  }

  classifyImages(images: readonly IdentifiedImage[]): Promise<AiResult<readonly ImageClassification[]>> {
    this.calls.push(`classifyImages(${images.map((i) => i.photoId).join(',')})`);
    const queued = this.classifications.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    // Nothing queued: assume receipts, which is what the app is usually given.
    return Promise.resolve(
      aiOk(images.map((i) => ({ photoId: i.photoId, type: OrderImageType.RECEIPT, confidence: 0.9 }))),
    );
  }

  extractOrder(images: readonly IdentifiedImage[]): Promise<AiResult<AiOrderExtraction>> {
    this.calls.push(`extractOrder(${images.map((i) => i.photoId).join(',')})`);
    return Promise.resolve(
      this.extractions.shift() ?? aiOk({ supplier: null, items: [], warnings: [] }),
    );
  }

  identifyProducts(image: IdentifiedImage): Promise<AiResult<ProductIdentification>> {
    this.calls.push(`identifyProducts(${image.photoId})`);
    return Promise.resolve(this.identifications.shift() ?? aiOk({ products: [], warnings: [] }));
  }

  countCases(images: readonly IdentifiedImage[]): Promise<AiResult<AiCaseCount>> {
    this.calls.push(`countCases(${images.map((i) => i.photoId).join(',')})`);
    return Promise.resolve(this.counts.shift() ?? aiOk({ sightings: [], warnings: [] }));
  }

  resolveQuestion(
    question: string,
    _items: readonly QuestionItemSummary[],
    _history: readonly string[] = [],
  ): Promise<AiResult<OrderQuestionResolution>> {
    this.calls.push(`resolveQuestion(${question})`);
    return Promise.resolve(
      this.resolutions.shift() ?? aiOk({ kind: 'unresolved', reason: 'nothing queued' }),
    );
  }
}
