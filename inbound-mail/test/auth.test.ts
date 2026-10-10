import { describe, it, expect } from "vitest";
import { parseAuth, authVerdict, parseRoutes } from "../src/index";

const h = (v?: string) => new Headers(v ? { "authentication-results": v } : {});
describe("auth", () => {
  it("rejects dmarc fail", () => expect(authVerdict(parseAuth(h("mx; spf=fail; dkim=none; dmarc=fail")), false)).toMatch(/DMARC/));
  it("accepts dkim pass", () => expect(authVerdict(parseAuth(h("mx; spf=none; dkim=pass; dmarc=pass")), false)).toBeNull());
  it("rejects all-none when header present", () => expect(authVerdict(parseAuth(h("mx; spf=none; dkim=none; dmarc=none")), false)).not.toBeNull());
  it("accepts when header absent", () => expect(authVerdict(parseAuth(h()), false)).toBeNull());
  it("lenient skips", () => expect(authVerdict(parseAuth(h("mx; dmarc=fail")), true)).toBeNull());
  it("routes", () => expect(parseRoutes("A@x.com=s, b@y.com=t").get("a@x.com")).toBe("s"));
});
