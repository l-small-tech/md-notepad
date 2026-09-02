/**
 * The human-readable reason behind a thrown value, for the one-line notices
 * the UI shows when a file operation fails. A bare "Could not rename" leaves
 * the user guessing; "Could not rename: io error: The system cannot move the
 * file to a different disk drive" tells them (and us) what actually went
 * wrong — which matters most on cloud-synced folders, where the filesystem
 * refuses things a local disk allows.
 */

/** The message carried by `error`, or `''` when it has none worth showing. */
export function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim();
  }
  if (typeof error === 'string') {
    return error.trim();
  }
  return '';
}

/**
 * `lead` finished as a sentence: `"<lead>: <detail>"` when the error carries
 * a message, `"<lead>."` when it does not.
 */
export function withErrorDetail(lead: string, error: unknown): string {
  const detail = errorDetail(error);
  return detail ? `${lead}: ${detail}` : `${lead}.`;
}
