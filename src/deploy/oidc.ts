import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "../config.ts";

const ISSUER = "https://token.actions.githubusercontent.com";
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));

export type DeployOrigin = NonNullable<Config["deploy"]>;

export interface DeployRun {
  repository: string;
  sha: string;
  runId: string;
  runAttempt: string;
  actor: string;
}

/** Verifies a GitHub Actions OIDC token minted by the configured production deploy workflow. */
export async function verifyDeployToken(token: string, audience: string, origin: DeployOrigin): Promise<DeployRun> {
  const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience, algorithms: ["RS256"] });
  const claim = (name: string): string => {
    const value = payload[name];
    if (typeof value !== "string" || !value) throw new Error(`token has no ${name} claim`);
    return value;
  };
  const workflow = `${origin.repository}/.github/workflows/${origin.workflow}@${origin.ref}`;
  if (claim("repository") !== origin.repository) throw new Error(`repository ${claim("repository")} is not allowed`);
  if (claim("ref") !== origin.ref) throw new Error(`ref ${claim("ref")} is not allowed`);
  if (claim("workflow_ref") !== workflow) throw new Error(`workflow ${claim("workflow_ref")} is not allowed`);
  return {
    repository: origin.repository,
    sha: claim("sha"),
    runId: claim("run_id"),
    runAttempt: claim("run_attempt"),
    actor: claim("actor"),
  };
}
