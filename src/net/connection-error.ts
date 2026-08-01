const TOKEN_VERIFICATION_ERROR = "Failed to verify token:";

export function isTokenVerificationError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith(TOKEN_VERIFICATION_ERROR);
}

export async function connectWithGuestTokenFallback<T>(
  guestToken: string | undefined,
  connect: (token: string | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await connect(guestToken);
  } catch (error) {
    if (guestToken === undefined || !isTokenVerificationError(error)) throw error;
    return connect(undefined);
  }
}
