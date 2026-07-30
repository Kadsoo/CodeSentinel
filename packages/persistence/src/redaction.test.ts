import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { redactText } from "./redaction.js";

describe("redactText", () => {
  it.each([
    ["Authorization: Bearer sk-proj-1234567890abcdef", "sk-proj-1234567890abcdef"],
    ["api_key=sk_1234567890abcdef", "sk_1234567890abcdef"],
    [".password=dot-prefixed-secret", "dot-prefixed-secret"],
    ["-token=dash-prefixed-secret", "dash-prefixed-secret"],
    ['{"refresh_token":"token-value-123456"}', "token-value-123456"],
    ["token\u200B=split-secret-value", "split-secret-value"],
    ["ghp_1234567890abcdef", "ghp_1234567890abcdef"],
    [
      "https://example.test/callback?token=query-secret-value&safe=1",
      "query-secret-value",
    ],
    ["x".repeat(40), "x".repeat(40)],
  ])("redacts a secret and remains idempotent: %s", (input, secret) => {
    const redacted = redactText(input);

    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain(secret);
    expect(redactText(redacted)).toBe(redacted);
  });

  it.each([
    ["sk-abcdefghijk-", "[REDACTED]"],
    ["sk_abcdefghijk-", "[REDACTED]"],
    ["pk_abcdefghijk-", "[REDACTED]"],
    ["rk_abcdefghijk-", "[REDACTED]"],
    ["ghp_abcdefghijk-", "[REDACTED]"],
    ["/sk-abcdefghijkl", "/[REDACTED]"],
    ["-sk-abcdefghijkl", "-[REDACTED]"],
    ["+sk-abcdefghijkl", "+[REDACTED]"],
    ["=sk-abcdefghijkl", "=[REDACTED]"],
    ["/ghp_abcdefghijkl", "/[REDACTED]"],
  ])(
    "redacts a known-prefix token at an allowed boundary: %s",
    (input, expected) => {
      expect(redactText(input)).toBe(expected);
    },
  );

  it("rejects an oversized input without serializing the secret", () => {
    const secret = `sk-proj-${"x".repeat(70_000)}`;

    try {
      redactText(secret);
      throw new Error("expected redactText to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_PERSISTENCE_INPUT" });
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it("leaves ordinary text unchanged", () => {
    expect(redactText("ordinary text is safe")).toBe("ordinary text is safe");
  });

  it("accepts an input exactly at the scan limit and bounds the output", () => {
    const input = "safe text ".repeat(7_282).slice(0, 65_536);

    expect(input).toHaveLength(65_536);
    expect(redactText(input)).toHaveLength(4_096);
  });

  it("redacts before truncating a secret at the output boundary", () => {
    const secret = "sk-proj-1234567890abcdef";
    const redacted = redactText(`${"a ".repeat(2_043)}${secret}`);

    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toMatch(/sk-proj-?$/);
  });

  it.each([
    [
      '{"password":"correct horse battery staple","safe":"keep me"}',
      '{"password":"[REDACTED]","safe":"keep me"}',
    ],
    [
      '{"token":"alpha,beta;gamma","safe":"keep me"}',
      '{"token":"[REDACTED]","safe":"keep me"}',
    ],
    [
      '{"pass\\u0077ord":"short-secret-value","safe":"keep me"}',
      '{"pass\\u0077ord":"[REDACTED]","safe":"keep me"}',
    ],
    [
      '{"password":"alpha\\" beta\\\\gamma;delta","safe":"keep me"}',
      '{"password":"[REDACTED]","safe":"keep me"}',
    ],
    [
      '{"pass\\u200bword":"format-split-secret","safe":"keep me"}',
      '{"pass\\u200bword":"[REDACTED]","safe":"keep me"}',
    ],
  ])("redacts one complete quoted sensitive value: %s", (input, expected) => {
    const redacted = redactText(input);

    expect(redacted).toBe(expected);
    expect(redactText(redacted)).toBe(redacted);
  });

  it("redacts multiple quoted secrets without consuming adjacent safe fields", () => {
    const input =
      '{"password":"one two,three;four","safe":"keep spaces,comma;semicolon","token":"five six;seven,eight","other":"unchanged"}';

    expect(redactText(input)).toBe(
      '{"password":"[REDACTED]","safe":"keep spaces,comma;semicolon","token":"[REDACTED]","other":"unchanged"}',
    );
  });

  it.each([
    [
      'prefix token="alpha,beta;gamma" safe=keep',
      'prefix token="[REDACTED]" safe=keep',
    ],
    [
      "https://example.test/callback?token=query-secret-value&safe=1",
      "https://example.test/callback?token=[REDACTED]&safe=1",
    ],
  ])("preserves safe neighbors of a legal assignment: %s", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each([
    [
      '{"password":"unterminated secret tail,still-secret',
      "[REDACTED]",
    ],
    [
      '{"password":"unterminated escaped tail\\',
      "[REDACTED]",
    ],
  ])("fails safe for an unterminated quoted secret: %s", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each([
    [
      '{"password":"front""hidden tail,segment;9001"}',
      "[REDACTED]",
    ],
    [
      '{"password":"""space secret,tail;end"}',
      "[REDACTED]",
    ],
  ])("fails safe for an ambiguous closing quote: %s", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each([
    '{"password\\":"MALFORMED_KEY_SECRET_2"}',
    '{"passw\\ord":"MALFORMED_KEY_SECRET"}',
    '{"passw\\u007ord":"SHORT_INVALID_UNICODE_SECRET"}',
    '{"password\\q":"MALFORMED_SUFFIX_SECRET","safe":"keep"}',
    '{"api_key\\q":"MALFORMED_API_KEY_SECRET","safe":"keep"}',
    '{"authorization\\q":"MALFORMED_AUTH_SECRET","safe":"keep"}',
    '{"passw\\xord":"MALFORMED_MIDDLE_SECRET","safe":"keep"}',
    '{"safe":"unterminated, "pass\\u0077ord":"SHIFTED_SECRET"}',
    '{"safe":"unterminated, "pass\\u0077ord":"SHIFTED_SECRET"}"',
    '{"safe":"unterminated, "password":"SHIFTED_EXACT_SECRET"}"',
    '{"safe":"unterminated, "token":"SHIFTED_TOKEN_SECRET"}"',
    '"prefix "password":"SHIFTED_PREFIX_SECRET""',
    "passw\\uXord=HIDDEN_BARE_UNICODE_SECRET",
    'token=front"HIDDEN_UNQUOTED_TAIL',
    "token=front'HIDDEN_SINGLE_QUOTE_TAIL",
    "token=front\\,HIDDEN_COMMA_TAIL",
    "token=front\\ HIDDEN_SPACE_TAIL",
    "token=front\\&HIDDEN_AMPERSAND_TAIL",
    "token=front\\;HIDDEN_SEMICOLON_TAIL",
    '{"token":front\\,HIDDEN_JSON_TAIL,"safe":"keep"}',
    '{"password":{"raw":"OBJECT_SECRET"}}',
    '{"token":["ARRAY_SECRET_ONE","ARRAY_SECRET_TWO"]}',
    'password={"raw":"OBJECT_ASSIGN_SECRET"}',
  ])(
    "returns whole redaction when sensitive syntax is ambiguous: %s",
    (input) => {
      expect(redactText(input)).toBe("[REDACTED]");
    },
  );

  it.each([
    'ordinary "unterminated text',
    '{"safe\\":"ordinary malformed value"}',
  ])("fails closed for globally ambiguous quoted text: %s", (input) => {
    expect(redactText(input)).toBe("[REDACTED]");
  });

  it.each([
    [
      "Bearer\nnewline-secret-tail",
      "Bearer [REDACTED]",
    ],
    [
      "Be\u0000arer\nsplit-keyword-secret-tail",
      "Bearer [REDACTED]",
    ],
    [
      "Authorization: Bearer\ncombined-secret-tail",
      "Authorization: Bearer [REDACTED]",
    ],
  ])("redacts a Bearer token split by control characters: %s", (input, expected) => {
    const redacted = redactText(input);

    expect(redacted).toBe(expected);
    expect(redactText(redacted)).toBe(redacted);
  });

  it.each([
    [
      '{"safe":"Bearer bearer-secret","other":"keep"}',
      '{"safe":"Bearer [REDACTED]","other":"keep"}',
    ],
    [
      "items=[Bearer bearer-secret] safe=keep",
      "items=[Bearer [REDACTED]] safe=keep",
    ],
    [
      "call(Bearer bearer-secret)&safe=1",
      "call(Bearer [REDACTED])&safe=1",
    ],
  ])("preserves safe syntax after a Bearer token: %s", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each([
    [
      "plain key | paired quotes | quoted value | comma",
      '{"password":"matrix secret","safe":"keep"}',
      '{"password":"[REDACTED]","safe":"keep"}',
    ],
    [
      "unicode key | paired quotes | quoted value | comma",
      '{"pass\\u0077ord":"matrix secret","safe":"keep"}',
      '{"pass\\u0077ord":"[REDACTED]","safe":"keep"}',
    ],
    [
      "invalid key escape | paired quotes | quoted value | comma",
      '{"password\\q":"matrix secret","safe":"keep"}',
      "[REDACTED]",
    ],
    [
      "plain key | shifted balanced quotes | quoted value | quote",
      '{"safe":"unterminated, "password":"matrix secret"}"',
      "[REDACTED]",
    ],
    [
      "plain key | paired quotes | object value | brace",
      '{"password":{"raw":"matrix secret"}}',
      "[REDACTED]",
    ],
    [
      "plain key | bare value | escaped continuation | comma",
      "token=front\\,matrix-secret-tail",
      "[REDACTED]",
    ],
    [
      "plain key | bare value | escaped continuation | ampersand",
      "token=front\\&matrix-secret-tail",
      "[REDACTED]",
    ],
    [
      "Bearer | paired quotes | quoted value | quote",
      '{"safe":"Bearer matrix-bearer-secret","other":"keep"}',
      '{"safe":"Bearer [REDACTED]","other":"keep"}',
    ],
    [
      "Bearer | control-split keyword | bare value | newline",
      "Be\u0000arer\nmatrix-bearer-secret",
      "Bearer [REDACTED]",
    ],
    [
      "known prefix | bare value | hyphen suffix | slash boundary",
      "/sk-abcdefghijk-",
      "/[REDACTED]",
    ],
  ])("covers the fixed lexer matrix: %s", (_case, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("scans an escaped Unicode key before bounding the persisted output", () => {
    const secret = "boundary secret,with;punctuation";
    const head = `${"界".repeat(4_050)}{"pass\\u0077ord":"${secret}"}`;
    const input = head + "尾".repeat(65_536 - head.length);
    const redacted = redactText(input);

    expect(input).toHaveLength(65_536);
    expect(redacted).toHaveLength(4_096);
    expect(redacted).toContain('{"pass\\u0077ord":"[REDACTED]"}');
    expect(redacted).not.toContain(secret);
    expect(redacted.startsWith("界".repeat(4_050))).toBe(true);
  });

  it("keeps a maximum no-match assignment scan within a linear-time margin", () => {
    const input = "a.".repeat(32_768);
    const startedAt = performance.now();

    expect(redactText(input)).toHaveLength(4_096);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("keeps overlapping escaped quote scans within a linear-time margin", () => {
    const input = `"${'\\"'.repeat(32_767)}"`;
    const startedAt = performance.now();

    expect(input).toHaveLength(65_536);
    expect(redactText(input)).toHaveLength(4_096);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
