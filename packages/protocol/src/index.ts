/**
 * `protocol` — binary wire format (encode/decode) + message types, shared
 * byte-for-byte by client and server. Real codec + golden-byte fixtures land in
 * later build tickets; this is only the package stub.
 *
 * @see spec §5.1, §6.3, ADR-0002
 */
export const PROTOCOL_PACKAGE = 'protocol';

/** Trivial marker exercised by the toolchain until the real codec lands. */
export function protocolReady(): boolean {
  return true;
}
