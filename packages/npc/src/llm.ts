import Anthropic from '@anthropic-ai/sdk';

export interface LlmRequest {
  model: string;
  /** ルールなど、ゲームを通して変わらない部分（プロンプトキャッシュの対象） */
  system: string;
  /** user の先頭にある、ゲームを通して変わらない部分。指定するとキャッシュの対象にする（user はその続き） */
  userStable?: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** AIの呼び出し口。本番は Anthropic、テストではモックに差し替える。 */
export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export function createAnthropicClient(apiKey: string): LlmClient {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return {
    async complete(req) {
      const res = await client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          // 考える過程で出力枠を使い切ると本文が空になるため、思考は無効にする
          thinking: { type: 'disabled' },
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: [
            {
              role: 'user',
              content: req.userStable
                ? [
                    {
                      type: 'text',
                      text: req.userStable,
                      cache_control: { type: 'ephemeral' },
                    },
                    { type: 'text', text: req.user },
                  ]
                : req.user,
            },
          ],
        },
        { timeout: req.timeoutMs },
      );
      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return {
        text,
        // 予算は費用の目安なので、キャッシュの書き込み（1.25倍）と読み取り（0.1倍）は料金に合わせて数える
        inputTokens: Math.round(
          res.usage.input_tokens +
            (res.usage.cache_creation_input_tokens ?? 0) * 1.25 +
            (res.usage.cache_read_input_tokens ?? 0) * 0.1,
        ),
        outputTokens: res.usage.output_tokens,
      };
    },
  };
}
