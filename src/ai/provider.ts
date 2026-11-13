import type {
  AiCaseCount,
  AiOrderExtraction,
  AiResult,
  OrderImageType,
  OrderQuestionResolution,
  ProductIdentification,
} from '../core/ai-types';
import { AiResponseParser } from '../core/ai-parse';
import { GeminiClient, type GeminiConfig, type ImagePart } from './gemini';
import {
  CASE_COUNT_SYSTEM,
  IMAGE_CLASSIFICATION_SYSTEM,
  ORDER_EXTRACTION_SYSTEM,
  PRODUCT_IDENTIFICATION_PROMPT,
  PRODUCT_IDENTIFICATION_SYSTEM,
  QUESTION_SYSTEM,
  caseCountPrompt,
  imageClassificationPrompt,
  orderExtractionPrompt,
  questionPrompt,
  type QuestionItemSummary,
} from './prompts';

/** A photograph with the id the rest of the app knows it by. */
export interface IdentifiedImage extends ImagePart {
  readonly photoId: number;
}

export interface ImageClassification {
  readonly photoId: number;
  readonly type: OrderImageType;
  readonly confidence: number;
}

/**
 * Everything the app asks a model to do.
 *
 * Kept as an interface so the tests can run the whole application against a fake without a key,
 * a network, or a cent of anybody's quota.
 */
export interface AiProvider {
  readonly name: string;
  classifyImages(images: readonly IdentifiedImage[]): Promise<AiResult<readonly ImageClassification[]>>;
  extractOrder(images: readonly IdentifiedImage[]): Promise<AiResult<AiOrderExtraction>>;
  identifyProducts(image: IdentifiedImage): Promise<AiResult<ProductIdentification>>;
  countCases(images: readonly IdentifiedImage[]): Promise<AiResult<AiCaseCount>>;
  resolveQuestion(
    question: string,
    items: readonly QuestionItemSummary[],
    history?: readonly string[],
  ): Promise<AiResult<OrderQuestionResolution>>;
}

/** The real provider: prompts in, Gemini's text out, defensive parser in between. */
export class GeminiProvider implements AiProvider {
  readonly name = 'Gemini';
  private readonly client: GeminiClient;

  constructor(config: GeminiConfig) {
    this.client = new GeminiClient(config);
  }

  get model(): string {
    return this.client.model;
  }

  async classifyImages(
    images: readonly IdentifiedImage[],
  ): Promise<AiResult<readonly ImageClassification[]>> {
    const result = await this.client.generate({
      system: IMAGE_CLASSIFICATION_SYSTEM,
      prompt: imageClassificationPrompt(images.map((i) => i.photoId)),
      images,
      maxOutputTokens: 1024,
    });
    return result.ok ? AiResponseParser.imageClassification(result.value) : result;
  }

  async extractOrder(images: readonly IdentifiedImage[]): Promise<AiResult<AiOrderExtraction>> {
    const result = await this.client.generate({
      system: ORDER_EXTRACTION_SYSTEM,
      prompt: orderExtractionPrompt(images.map((i) => i.photoId)),
      images,
    });
    return result.ok ? AiResponseParser.orderExtraction(result.value) : result;
  }

  async identifyProducts(image: IdentifiedImage): Promise<AiResult<ProductIdentification>> {
    const result = await this.client.generate({
      system: PRODUCT_IDENTIFICATION_SYSTEM,
      prompt: PRODUCT_IDENTIFICATION_PROMPT,
      images: [image],
      maxOutputTokens: 2048,
    });
    return result.ok ? AiResponseParser.productIdentification(result.value) : result;
  }

  async countCases(images: readonly IdentifiedImage[]): Promise<AiResult<AiCaseCount>> {
    const result = await this.client.generate({
      system: CASE_COUNT_SYSTEM,
      prompt: caseCountPrompt(images.map((i) => i.photoId)),
      images,
      maxOutputTokens: 4096,
    });
    return result.ok ? AiResponseParser.caseCount(result.value) : result;
  }

  async resolveQuestion(
    question: string,
    items: readonly QuestionItemSummary[],
    history: readonly string[] = [],
  ): Promise<AiResult<OrderQuestionResolution>> {
    const result = await this.client.generate({
      system: QUESTION_SYSTEM,
      prompt: questionPrompt(question, items, history),
      maxOutputTokens: 2048,
    });
    return result.ok
      ? AiResponseParser.questionResolution(
          result.value,
          new Set(items.map((i) => i.itemId)),
        )
      : result;
  }
}
