import { MilvusClient, DataType, ConsistencyLevelEnum } from '@zilliz/milvus2-sdk-node';

export interface MarketInsight {
  id?: string | number;
  text: string;
  category: string;
  fortification_count: number;
  last_observed_date: string;
  example_stocks: string;
  vector?: number[];
  score?: number;
  term?: 'short_term' | 'monthly' | string;
}

export interface MilvusServiceConfig {
  address?: string;
  token?: string;
  collectionName?: string;
  dimension?: number;
  similarityThreshold?: number;
  client?: any;
}

export class MilvusService {
  private client: MilvusClient;
  public readonly collectionName: string;
  public readonly dimension: number;
  public readonly similarityThreshold: number;
  private initialized = false;

  constructor(config: MilvusServiceConfig) {
    if (config.client) {
      this.client = config.client;
    } else {
      if (!config.address) {
        throw new Error('Milvus address is required to initialize MilvusService');
      }
      let address = config.address.trim();
      if (address.startsWith('https://') && !address.slice(8).includes(':')) {
        address = `${address}:443`;
      }
      const ssl = address.startsWith('https://') || Boolean(config.token);
      this.client = new MilvusClient({
        address,
        token: config.token,
        ssl,
      });
    }
    this.collectionName = config.collectionName || 'market_insights';
    this.dimension = config.dimension || 2048;
    this.similarityThreshold = config.similarityThreshold ?? 0.82;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const has = await this.client.hasCollection({ collection_name: this.collectionName });
      if (!has.value) {
        await this.client.createCollection({
          collection_name: this.collectionName,
          dimension: this.dimension,
          metric_type: 'COSINE',
          primary_field_name: 'id',
          id_type: DataType.Int64,
          auto_id: true,
          enable_dynamic_field: true,
        });
      } else {
        await this.client.loadCollectionSync({ collection_name: this.collectionName });
      }
      this.initialized = true;
    } catch (err) {
      console.warn(`[Milvus] Failed to initialize collection ${this.collectionName}:`, err);
      throw err;
    }
  }

  async searchInsight(
    embedding: number[],
    topK = 1,
    threshold = this.similarityThreshold,
    term?: 'short_term' | 'monthly',
  ): Promise<MarketInsight | null> {
    try {
      await this.initialize();
      const limit = term ? Math.max(topK, 5) : topK;
      const searchRes = await this.client.search({
        collection_name: this.collectionName,
        data: [embedding],
        limit,
        output_fields: ['id', 'vector', 'text', 'category', 'fortification_count', 'last_observed_date', 'example_stocks', 'term'],
        consistency_level: ConsistencyLevelEnum.Strong,
      });

      const results = searchRes.results;
      if (!results || results.length === 0) return null;
      const rawList: any[] = Array.isArray(results[0]) ? results[0] : results;
      if (!rawList.length) return null;

      // Filter by term if requested
      let candidateMatches = rawList;
      if (term) {
        candidateMatches = rawList.filter(item => {
          const itemTerm = item.term;
          const cat = String(item.category || '').toLowerCase();
          if (term === 'short_term') {
            return itemTerm === 'short_term' || cat.includes('short-term') || cat.includes('price movement');
          } else {
            return itemTerm === 'monthly' || (!itemTerm && !cat.includes('short-term'));
          }
        });
      }

      if (!candidateMatches.length) return null;
      const top = candidateMatches[0];
      if (!top || typeof top.score !== 'number') return null;

      if (top.score < threshold) return null;

      return {
        id: top.id,
        text: String(top.text ?? ''),
        category: String(top.category ?? 'General'),
        term: (top.term as any) || (term ?? 'short_term'),
        fortification_count: Number(top.fortification_count ?? 1),
        last_observed_date: String(top.last_observed_date ?? ''),
        example_stocks: String(top.example_stocks ?? ''),
        vector: Array.isArray(top.vector) ? top.vector : embedding,
        score: top.score,
      };
    } catch (err) {
      console.warn('[Milvus] Search insight failed:', err);
      return null;
    }
  }

  async fortifyInsight(
    insight: MarketInsight,
    additionalStock: string,
    date: string,
    refinedText?: string,
    newVector?: number[],
    term?: 'short_term' | 'monthly',
  ): Promise<void> {
    try {
      await this.initialize();
      const newCount = (insight.fortification_count || 1) + 1;
      const currentStocks = (insight.example_stocks || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (additionalStock && !currentStocks.includes(additionalStock)) {
        currentStocks.push(additionalStock);
      }
      const updatedStocks = currentStocks.slice(-10).join(', ');
      const vector = newVector || insight.vector;
      if (!vector) {
        console.warn(`[Milvus] Cannot fortify insight id=${insight.id} without vector data`);
        return;
      }

      await this.client.upsert({
        collection_name: this.collectionName,
        data: [{
          id: insight.id,
          vector,
          text: refinedText || insight.text,
          category: insight.category,
          term: term || insight.term || 'short_term',
          fortification_count: newCount,
          last_observed_date: date,
          example_stocks: updatedStocks,
        }],
      });
      if (typeof this.client.flushSync === 'function') {
        await this.client.flushSync({ collection_names: [this.collectionName] });
      }
      console.log(`[Milvus] Fortified ${term || insight.term || 'insight'} id=${insight.id} (count=${newCount}) with stock ${additionalStock}`);
    } catch (err) {
      console.warn('[Milvus] Fortify insight failed:', err);
    }
  }

  async insertInsight(
    embedding: number[],
    text: string,
    category: string,
    date: string,
    symbol: string,
    term: 'short_term' | 'monthly' = 'short_term',
  ): Promise<void> {
    try {
      await this.initialize();
      await this.client.insert({
        collection_name: this.collectionName,
        data: [{
          vector: embedding,
          text,
          category,
          term,
          fortification_count: 1,
          last_observed_date: date,
          example_stocks: symbol,
        }],
      });
      if (typeof this.client.flushSync === 'function') {
        await this.client.flushSync({ collection_names: [this.collectionName] });
      }
      console.log(`[Milvus] Inserted new ${term} insight for ${symbol}: "${text.slice(0, 60)}..."`);
    } catch (err) {
      console.warn('[Milvus] Insert insight failed:', err);
    }
  }
}

export function createMilvusService(env: {
  MILVUS_URI?: string;
  MILVUS_ADDRESS?: string;
  MILVUS_TOKEN?: string;
  MILVUS_COLLECTION_NAME?: string;
  MILVUS_SIMILARITY_THRESHOLD?: number;
} = process.env): MilvusService | null {
  const address = env.MILVUS_URI || env.MILVUS_ADDRESS;
  if (!address) return null;
  return new MilvusService({
    address,
    token: env.MILVUS_TOKEN,
    collectionName: env.MILVUS_COLLECTION_NAME || 'market_insights',
    similarityThreshold: env.MILVUS_SIMILARITY_THRESHOLD ?? 0.82,
  });
}
