import type { OpenCodeServer } from './server';
import type { ChatModelSelection } from '../shared/protocol';
import { asRecord, isString } from '../shared/type-utils';

type GenerationServer = Pick<OpenCodeServer, 'request'> &
  Partial<Pick<OpenCodeServer, 'apiVersion'>>;
const GENERATE_PATH = '/api/experimental/generate';

/** Null means no generation was admitted and the caller can use a helper session. */
export async function tryGenerateOneShot(
  server: GenerationServer,
  input: {
    prompt: string;
    model: ChatModelSelection | null;
    directory?: string;
    signal: AbortSignal;
  }
): Promise<{ text: string } | null> {
  if (server.apiVersion !== 2) return null;
  input.signal.throwIfAborted();
  let specification;
  try {
    specification = await server.request('GET', '/openapi.json', undefined, {
      signal: input.signal,
      maxResponseBytes: 4 * 1024 * 1024,
    });
  } catch (error) {
    if (error instanceof Error && /^404\b/.test(error.message)) return null;
    throw error;
  }
  const paths = asRecord(asRecord(specification)?.paths);
  if (!asRecord(asRecord(paths?.[GENERATE_PATH])?.post)) return null;
  input.signal.throwIfAborted();
  let response;
  try {
    response = await server.request(
      'POST',
      GENERATE_PATH,
      {
        prompt: input.prompt,
        model: input.model
          ? {
              providerID: input.model.providerID,
              id: input.model.modelID,
              variant: input.model.variant,
            }
          : null,
      },
      { directory: input.directory, signal: input.signal }
    );
  } catch (error) {
    input.signal.throwIfAborted();
    // V2 resolves the base runner's models before contacting the provider.
    // Configured custom models may need the location-scoped helper session.
    if (
      input.model &&
      error instanceof Error &&
      error.message === `400 Model unavailable: ${input.model.providerID}/${input.model.modelID}`
    )
      return null;
    throw error;
  }
  input.signal.throwIfAborted();
  const data = asRecord(asRecord(response)?.data);
  if (!isString(data?.text))
    throw new Error('OpenCode returned an invalid one-shot generation response');
  return { text: data.text };
}
