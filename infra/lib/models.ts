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
  /**
   * Regions this stack may deploy to with this profile: the profile's source
   * Regions (where the call is made from) that keep every request in the US.
   */
  sourceRegions: readonly string[];
}

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'us.amazon.nova-2-lite-v1:0': {
    profileId: 'us.amazon.nova-2-lite-v1:0',
    foundationModelId: 'amazon.nova-2-lite-v1:0',
    // Source Regions from the Nova 2 Lite model card (checked 2026-10-16). The
    // profile also accepts calls from ca-central-1 and ca-west-1, but from there
    // it can route to a Canadian Region, so we leave those two out.
    sourceRegions: ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2'],
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

/**
 * Stops synth when the stack's Region can't call the profile. Without this, the
 * deploy can succeed while every model call fails at run time.
 */
export function assertRegionSupported(profile: ModelProfile, region: string): void {
  if (!profile.sourceRegions.includes(region)) {
    throw new Error(
      `${profile.profileId} can't be called from ${region}. Deploy to one of ${profile.sourceRegions.join(', ')} ` +
        '(set AWS_REGION or the Region in your AWS profile), or pass -c modelId=<profile for your Region> and add it to infra/lib/models.ts.',
    );
  }
}
