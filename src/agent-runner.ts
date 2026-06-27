import type { ReviewVerdict, Usage } from './domain.ts';

/**
 * Narrowed view of the one event we care about: a `message.updated` whose info
 * is an AssistantMessage. The opencode SDK's event type is a wide union, so we
 * validate at the boundary (no casts) and keep only the fields usage needs.
 */
interface AssistantInfo {
  readonly id: string;
  readonly modelID: string;
  readonly providerID: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly created: number;
  readonly completed: number | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Decode one event into an `AssistantInfo`, or null if it isn't one. */
const assistantInfo = (ev: unknown): AssistantInfo | null => {
  if (!isRecord(ev) || ev.type !== 'message.updated' || !isRecord(ev.properties)) return null;
  const info = ev.properties.info;
  if (!isRecord(info) || info.role !== 'assistant') return null;
  if (!isRecord(info.tokens) || !isRecord(info.time)) return null;
  const id = str(info.id);
  const modelID = str(info.modelID);
  const providerID = str(info.providerID);
  const tokensIn = num(info.tokens.input);
  const tokensOut = num(info.tokens.output);
  const created = num(info.time.created);
  if (
    id === undefined ||
    modelID === undefined ||
    providerID === undefined ||
    tokensIn === undefined ||
    tokensOut === undefined ||
    created === undefined
  ) {
    return null;
  }
  return {
    id,
    modelID,
    providerID,
    tokensIn,
    tokensOut,
    created,
    completed: num(info.time.completed),
  };
};

/**
 * Roll the opencode event stream into one `Usage`. `message.updated` fires
 * repeatedly per message with cumulative tokens, so we keep the LAST update per
 * message id, then sum across distinct messages. The model is `provider/model`
 * (matching the config strings) and wall time spans first-created to last-
 * completed. Non-zero tokens are the proof a real run happened.
 */
export const parseUsage = (events: ReadonlyArray<unknown>): Usage => {
  const byId = new Map<string, AssistantInfo>();
  for (const ev of events) {
    const info = assistantInfo(ev);
    if (info !== null) byId.set(info.id, info);
  }
  const infos = [...byId.values()];
  const tokensIn = infos.reduce((n, i) => n + i.tokensIn, 0);
  const tokensOut = infos.reduce((n, i) => n + i.tokensOut, 0);
  const last = infos.at(-1);
  const model = last === undefined ? '' : `${last.providerID}/${last.modelID}`;
  const created = infos.map((i) => i.created);
  const completed = infos.flatMap((i) => (i.completed === undefined ? [] : [i.completed]));
  const wallTimeSec =
    created.length > 0 && completed.length > 0
      ? Math.max(0, (Math.max(...completed) - Math.min(...created)) / 1000)
      : 0;
  return { model, tokensIn, tokensOut, wallTimeSec };
};

/** Stub — implemented in the GREEN step. */
export const parseVerdict = (_text: string): ReviewVerdict => {
  throw new Error('agent-runner: parseVerdict not implemented');
};
