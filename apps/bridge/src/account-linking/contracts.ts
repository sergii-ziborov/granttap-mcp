export type LoginMode = "personal" | "enterprise";

export type PublicAuthorization = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  intervalSec: number;
  mode: LoginMode;
  organization?: string;
};

export type PendingAuthorization = PublicAuthorization & {
  version: 1;
  controlBase: string;
  deviceCode: string;
  codeVerifier: string;
};

export type AccountMetadata = {
  version: 1;
  mode: LoginMode;
  accountId: string;
  userId: string;
  deviceId: string;
  devicePublicKey: string;
  controlBase: string;
  expiresAt: number;
  organizationId?: string;
};

export type AccountStatus =
  | { kind: "signed_out" }
  | { kind: "pending"; authorization: PublicAuthorization }
  | { kind: "signed_in" | "expired"; account: AccountMetadata };

export interface SecretVault {
  load(account: string): string | null;
  save(account: string, value: string): void;
  remove(account: string): void;
}
