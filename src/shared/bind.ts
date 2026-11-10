import { isIP } from "node:net";

export const DEFAULT_BIND_ADDRESS = "127.0.0.1";

export function validateBindAddress(address: string): string {
  if (isIP(address) === 0) {
    throw new Error(`Invalid bind address ${JSON.stringify(address)}; expected an IPv4 or IPv6 address`);
  }
  return address;
}

export function resolveBindAddress(flag?: string, environment?: string): string {
  return validateBindAddress(flag ?? environment ?? DEFAULT_BIND_ADDRESS);
}
