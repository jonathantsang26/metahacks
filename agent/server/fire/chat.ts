import type {ChatCompletionCreateParamsNonStreaming} from 'openai/resources/chat/completions';

/**
 * The chat-client shapes from the Meta build's analyst loop (web/api/_lib/analyst.ts), which this
 * folder does not carry: budget.ts and model.ts only need the types.
 */

export type ChatRequest = Pick<ChatCompletionCreateParamsNonStreaming, 'model' | 'messages' | 'tools' | 'tool_choice' | 'max_completion_tokens'>;
type ToolCallLike = {id: string; type: string; function?: {name: string; arguments: string}};
export type ChatReply = {
  choices: {message: {content: string | null; tool_calls?: ToolCallLike[] | null}; finish_reason?: string | null}[];
  usage?: {prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: {cached_tokens?: number} | null} | null;
};
export type ChatClient = {create(req: ChatRequest): Promise<ChatReply>};
