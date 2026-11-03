import { describe, expect, test } from "bun:test";
import { isLoopbackHost, listLanHosts, listLocalAddresses } from "../src/lib/local-addresses";

describe("isLoopbackHost", () => {
  test("recognises the loopback spellings", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.53")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  test("a LAN address is not loopback", () => {
    expect(isLoopbackHost("10.126.126.2")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
    expect(isLoopbackHost("172.20.0.3")).toBe(false);
  });
});

describe("local address enumeration", () => {
  test("lists IPv4 addresses only", () => {
    for (const addr of listLocalAddresses()) {
      expect(addr.family).toBe("IPv4");
    }
  });

  test("LAN hosts exclude loopback and contain no duplicates", () => {
    const hosts = listLanHosts();
    expect(new Set(hosts).size).toBe(hosts.length);
    for (const host of hosts) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  test("the machine has at least one non-internal IPv4 address", () => {
    // A CI box always has eth0; without one the LAN endpoint list would be empty and
    // the GUI would silently hide the section.
    expect(listLocalAddresses().some(addr => !addr.internal)).toBe(true);
  });
});
