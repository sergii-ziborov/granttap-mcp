import type { PeerConfig } from "../../packages/core/relay-client";
import {
  saveGrokBotEndpoint,
  type GrokBotEndpointBundle,
} from "../../apps/bridge/src/mesh/endpoint";

/** Every scoped Mesh operation a Grok Bot credential may carry; never administrative. */
export const GROK_BOT_OPERATIONS = [
  "status", "task", "claim", "release", "progress", "question", "answer",
  "handoff", "accept_handoff", "reject_handoff", "artifact_ready", "complete",
] as const;

type Options = {
  pairing: PeerConfig;
  projectIds: string[];
  actorId: string;
  createdAt: number;
};

export function grokBotEndpointBundle(options: Options): GrokBotEndpointBundle {
  const { pairing, projectIds, actorId, createdAt } = options;
  return {
    version: 1,
    endpoint: {
      endpointId: "grok-cloud", kind: "grok_bot_cloud", displayName: "Grok Bot Cloud",
      publicKey: Buffer.from(pairing.myPublicKey, "base64").toString("base64url"),
      credentialId: "credential", status: "active", createdAt,
    },
    credential: {
      credentialId: "credential", endpointId: "grok-cloud", status: "active",
      projectIds: [...projectIds], operations: [...GROK_BOT_OPERATIONS],
      issuedAt: createdAt, expiresAt: createdAt + 86_400_000,
    },
    actors: [{
      actorId, endpointId: "grok-cloud", kind: "persistent_agent",
      displayName: "QA Bot", status: "idle", enabled: true,
    }],
    pairing: { ...pairing, role: "machine" },
    policy: {
      type: "mesh.endpoint.policy", endpointId: "grok-cloud", credentialId: "credential",
      enabled: true, status: "active", projectIds: [...projectIds],
      actors: [{ actorId, enabled: true }], revision: 1, createdAt,
    },
    inviteExpiresAt: createdAt + 600_000,
  } as GrokBotEndpointBundle;
}

export function saveTestGrokBotEndpoint(options: Options): GrokBotEndpointBundle {
  const bundle = grokBotEndpointBundle(options);
  saveGrokBotEndpoint(bundle);
  return bundle;
}
