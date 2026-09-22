// PKCE (RFC 7636, S256 only) and the authorization state value, from injected
// randomness so tests can name the bytes.
export type Random = (bytes: number) => Uint8Array;

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

export function codeVerifier(random: Random): string {
	return base64url(random(32));
}

export function codeChallenge(verifier: string): string {
	return base64url(new Bun.CryptoHasher("sha256").update(verifier).digest());
}

export function stateValue(random: Random): string {
	return base64url(random(32));
}
