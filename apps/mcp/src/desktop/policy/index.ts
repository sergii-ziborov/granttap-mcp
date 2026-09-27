import { ProjectPolicySet, type ProjectPolicyPayload } from "../../../../../packages/protocol/schema";
import { desktopPolicyScope } from "./scope";
import { createProjectPolicyRuntime, projectPolicyRuntimeDependencies,
  type ProjectPolicyRuntimeDependencies } from "../../../../bridge/src/project-policy/runtime";

type Options = {
  storePath?: string; endpointId?: string;
  engine?: ProjectPolicyRuntimeDependencies["client"];
  providers?: ProjectPolicyRuntimeDependencies["providers"];
};

/** The desktop uses the same policy application and provider acknowledgement as relay clients. */
export async function desktopProjectPolicy(operation: string, input: unknown, options: Options = {}) {
  const scope = desktopPolicyScope(input, options);
  if (!scope) return undefined;
  const { query, projectId, endpointId } = scope;
  let request: ProjectPolicySet | undefined;
  if (operation === "desktop.policy_set") {
    if (typeof query.request !== "string" || Buffer.byteLength(query.request) > 64 * 1_024) return undefined;
    try { request = ProjectPolicySet.parse(JSON.parse(query.request)); } catch { return undefined; }
    if (request.projectId !== projectId
      || request.policy.revision !== request.expectedRevision + 1) return undefined;
  } else if (operation !== "desktop.policy_status") return undefined;
  const payloads: ProjectPolicyPayload[] = [];
  const defaults = projectPolicyRuntimeDependencies();
  const client = options.engine ?? defaults.client;
  const runtime = createProjectPolicyRuntime({ ...defaults,
    client: { request: (query, requestOptions) => client.request(query,
      { ...requestOptions, timeoutMs: 6_000 }) },
    endpointId: () => endpointId, providers: options.providers ?? defaults.providers,
    log: undefined,
    send: async (_relay, payload) => { payloads.push(payload); },
  });
  let accepted = true;
  if (request) accepted = await runtime.apply(undefined, request);
  else {
    await runtime.publish(undefined, [projectId]);
    if (!payloads.length) await runtime.publish(undefined, [projectId]);
  }
  if (!payloads.length) throw new Error("Mesh policy is unavailable from the local Engine");
  return { operation, project_id: projectId, endpoint_id: endpointId, accepted, payloads };
}
