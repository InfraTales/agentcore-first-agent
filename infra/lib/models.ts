/**
 * Cross-Region inference profiles this stack knows how to grant. A profile routes
 * each request to one of several Regions, so the runtime role needs InvokeModel on
 * the profile and on the foundation model behind it.
 */
export interface ModelProfile {
  /** The ID you pass to Bedrock, for example us.amazon.nova-2-lite-v1:0. */
  profileId: string;
  /** The foundation model behind the profile. */
  foundationModelId: string;
}

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'us.amazon.nova-2-lite-v1:0': {
    profileId: 'us.amazon.nova-2-lite-v1:0',
    foundationModelId: 'amazon.nova-2-lite-v1:0',
  },
};

export const DEFAULT_MODEL_ID = 'us.amazon.nova-2-lite-v1:0';

export function resolveModel(modelId: string | undefined): ModelProfile {
  const id = modelId ?? DEFAULT_MODEL_ID;
  const profile = MODEL_PROFILES[id];
  if (!profile) {
    throw new Error(`Unknown modelId "${id}". Add it to infra/lib/models.ts with its destination Regions.`);
  }
  return profile;
}
