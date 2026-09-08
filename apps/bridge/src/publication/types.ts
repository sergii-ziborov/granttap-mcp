/** What a publication analysis found, before anything is shown or sent. */

export type PublicationBoundaryKind =
  | "git_push"
  | "pr_body"
  | "issue_comment"
  | "package_publish"
  | "repo_create"
  | "remote_add"
  | "webhook_post"
  | "email_send";

export type DeltaSignalCode =
  | "foreign_subject_defect"
  | "identity_mint"
  | "root_escape"
  | "third_party_address";

/**
 * One thing worth naming in an approval, and where it was found.
 *
 * `subject` is the identifier the decision is actually about — a domain, a
 * handle, a package, a path. `evidence` is the short phrase that made it worth
 * asking about. Neither is a line of the delta: the whole point of this shape
 * is that a person sees the object of the action without the content of it
 * travelling anywhere.
 */
export type DisclosureSubjectFact = {
  readonly code: DeltaSignalCode;
  readonly subject: string;
  readonly evidence?: string;
  readonly where?: string;
};
