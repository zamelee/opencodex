import { networkInterfaces } from "node:os";

export interface LocalAddress {
  host: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
}

/** Every address this machine answers on. IPv4 only for the LAN list — IPv6 link-local
 *  addresses need a scope id and would just be noise in a copy-paste box. */
export function listLocalAddresses(): LocalAddress[] {
  const out: LocalAddress[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4") continue;
      out.push({ host: addr.address, family: "IPv4", internal: addr.internal });
    }
  }
  return out;
}

/**
 * Hosts a colleague on the LAN could use to reach this machine. Loopback is excluded —
 * `127.0.0.1` on their machine is their own machine.
 */
export function listLanHosts(): string[] {
  return listLocalAddresses()
    .filter(addr => !addr.internal)
    .map(addr => addr.host)
    .filter((host, index, all) => all.indexOf(host) === index);
}

/** True for addresses that only work on this machine. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}
