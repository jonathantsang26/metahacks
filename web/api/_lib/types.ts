/** Shapes shared by the analyst endpoint, its tools, the CLI and the eval. */

export type Cite = {id: string; layer: string; t?: string; lon?: number; lat?: number; label: string};

/** A cite as a tool produces it; the runner assigns the id when it registers it. */
export type ToolCite = Omit<Cite, 'id'>;

export type ToolOutput = {result: unknown; cites: ToolCite[]};

export type Mode = 'answer' | 'report';

export type HistoryTurn = {role: 'user' | 'assistant'; content: string};

export type AnalystRequest = {question: string; fire: string; history: HistoryTurn[]; mode: Mode};

export type Paragraph = {text: string; cites: Cite[]};

export type AnalystResponse = {
  paragraphs: Paragraph[];
  tool_calls: {name: string; args: unknown}[];
  dropped: {uncited: number; guardrail: number};
  model: string;
  /** Present only when nothing survived: no final answer, or every paragraph was removed. */
  note?: string;
};

/** What the model put in final_answer, before verification. */
export type RawParagraph = {text?: unknown; cite_ids?: unknown};
