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

  it("keeps a truncated quoted-safe result idempotent", () => {
    const input = `"${"ordinary text ".repeat(500)}"`;
    const redacted = redactText(input);

    expect(redacted).toBe("[REDACTED]");
    expect(redactText(redacted)).toBe(redacted);
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
    [
      '{"password":"sk\\u002dabcdefghijklmnop","safe":"keep"}',
      '{"password":"[REDACTED]","safe":"keep"}',
    ],
    [
      '{"authorization":"Bearer\\u0020short-secret","safe":"keep"}',
      '{"authorization":"[REDACTED]","safe":"keep"}',
    ],
    [
      `{"pass\\u0077ord":"${"A".repeat(31)}\\u0041","safe":"keep"}`,
      '{"pass\\u0077ord":"[REDACTED]","safe":"keep"}',
    ],
    [
      '{"password":"sk\\\\u005cu002dabcdefghijklmnop","safe":"keep"}',
      '{"password":"[REDACTED]","safe":"keep"}',
    ],
  ])("redacts one complete quoted sensitive value: %s", (input, expected) => {
    const redacted = redactText(input);

    expect(redacted).toBe(expected);
    expect(redactText(redacted)).toBe(redacted);
  });

  it.each([
    ["password", "password/*comment*/=INNER"],
    ["authorization", "password\\=INNER"],
    ["api_key", "token=front\\,tail"],
    ["token", 'password={"raw":"INNER"}'],
    ["password", "passw\\uXord=INNER"],
    ["password", "password/*unterminated"],
    ["password", "password//comment\n=INNER"],
  ])(
    "treats a directly protected quoted value as opaque: %s",
    (key, innerValue) => {
      const input = JSON.stringify({
        [key]: innerValue,
        safe: "keep",
      });
      const expected = JSON.stringify({
        [key]: "[REDACTED]",
        safe: "keep",
      });

      expect(redactText(input)).toBe(expected);
    },
  );

  it("treats a directly protected value behind an escaped key as opaque", () => {
    const input =
      '{"pass\\u0077ord":"password/*comment*/=INNER","safe":"keep"}';

    expect(redactText(input)).toBe(
      '{"pass\\u0077ord":"[REDACTED]","safe":"keep"}',
    );
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
    [
      'password="sk\\u002dabcdefghijklmnop" safe=keep',
      'password="[REDACTED]" safe=keep',
    ],
    [
      "password='sk\\u002dabcdefghijklmnop' safe=keep",
      "password='[REDACTED]' safe=keep",
    ],
    [
      'authorization="Bearer\\u0020short-secret" safe=keep',
      'authorization="[REDACTED]" safe=keep',
    ],
  ])("preserves safe neighbors of a legal assignment: %s", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each([
    [
      '"password"="sk\\u002dabcdefghijkl" safe=keep',
      '"password"="[REDACTED]" safe=keep',
    ],
    [
      "'password'='sk\\u002dabcdefghijkl' safe=keep",
      "'password'='[REDACTED]' safe=keep",
    ],
    [
      '"authorization"="Bearer\\u0020short-secret" safe=keep',
      '"authorization"="[REDACTED]" safe=keep',
    ],
    [
      '"pass\\u0077ord"="sk\\u002dabcdefghijkl" safe=keep',
      '"pass\\u0077ord"="[REDACTED]" safe=keep',
    ],
  ])(
    "preserves safe neighbors of a quoted-key assignment: %s",
    (input, expected) => {
      expect(redactText(input)).toBe(expected);
      expect(redactText(expected)).toBe(expected);
    },
  );

  it("fails closed for a quoted safe-field pseudo assignment", () => {
    const input =
      '"safe"="prefix \\"password\\"=\\"sk\\u002dabcdefghijkl\\"" safe=keep';

    expect(redactText(input)).toBe("[REDACTED]");
  });

  it.each([
    'password"=short-secret"',
    "password'=short-secret'",
    '{"password"":"LEAKVALUE"}',
    '{"password":""LEAKVALUE"}',
  ])(
    "fails closed when an assignment only emerges after quote removal: %s",
    (input) => {
      expect(redactText(input)).toBe("[REDACTED]");
    },
  );

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
    '{"safe":"unterminated, " password ":"secret-tail"}"',
    '"prefix "password":"SHIFTED_PREFIX_SECRET""',
    "passw\\uXord=HIDDEN_BARE_UNICODE_SECRET",
    '{"password"/*comment*/:"SYNTHETIC_COMMENT_9001"}',
    "password/*comment*/=SYNTHETIC_COMMENT_9002",
    '{"safe":"x\\" , \\"password\\":\\"SYNTHETIC_SECRET_9001"}',
    'Bearer "short-secret"',
    'Authorization: Bearer "short-secret"',
    "Bearer [short-secret]",
    "Bearer {short-secret}",
    "Bearer (short-secret)",
    "Bearer <short-secret>",
    'pass"word"=short-secret',
    '"pass"word=short-secret',
    'Be"arer" short-secret',
    'sk"-"abcdefghijkl',
    `aaaaaaaaaaaaaaaa"a"aaaaaaaaaaaaaaaa`,
    ["Be", "\\", "arer short-secret"].join(""),
    ["sk", "\\", "-abcdefghijkl"].join(""),
    ["a".repeat(16), "\\", "a".repeat(16)].join(""),
    ["Be", "\\", "\n", "arer short-secret"].join(""),
    ["sk", "\\", "\n", "-abcdefghijkl"].join(""),
    ["a".repeat(16), "\\", "\n", "a".repeat(16)].join(""),
    "pass/*join*/word=short-secret",
    "Bear/*join*/er short-secret",
    "sk/*join*/-abcdefghijkl",
    `${"a".repeat(16)}/*join*/${"a".repeat(16)}`,
    'pass"/*join*/word"=short-secret',
    "https://example.test/sk\\u002dabcdefghijklmnop",
    `http://example.test/path/${"a".repeat(16)}\\u0061${"a".repeat(16)}`,
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
    [
      "escaped pseudo field",
      '{"safe":"x\\" , \\"password\\":\\"SYNTHETIC_SECRET_9001"}',
    ],
    [
      "escaped pseudo field with a prefixed key",
      '{"safe":"x\\" , \\"api_key\\":\\"SYNTHETIC_PREFIX_SECRET_9001"}',
    ],
    [
      "escaped pseudo field with a comment-separated delimiter",
      '{"safe":"x\\"password\\"/*comment*/:\\"SYNTHETIC_ESC_COMMENT_9001"}',
    ],
    [
      "escaped quoted Bearer candidate",
      JSON.stringify({ safe: 'Bearer "short-secret"' }),
    ],
    [
      "Unicode-decoded known-prefix candidate",
      '{"safe":"sk\\u002dabcdefghijklmnop"}',
    ],
    [
      "Unicode-decoded long key-like candidate",
      `{"safe":"${"A".repeat(31)}\\u0041"}`,
    ],
    [
      "control-split assignment",
      JSON.stringify({ safe: "pass\u200Bword=decoded-short-secret" }),
    ],
    [
      "Unicode-decoded assignment delimiter",
      '{"safe":"x password\\u003ddecoded-short-secret"}',
    ],
    [
      "Unicode-decoded API key assignment delimiter",
      '{"safe":"api_key\\u003dshort-secret"}',
    ],
    [
      "Unicode-decoded Bearer separator",
      '{"safe":"Bearer\\u0020short-secret"}',
    ],
    [
      "Unicode-decoded sensitive-name prefix",
      '{"safe":"\\u0070assword=short-secret"}',
    ],
    [
      "Unicode-decoded Bearer keyword middle",
      '{"safe":"Be\\u0061rer short-secret"}',
    ],
    [
      "nested escape assignment",
      JSON.stringify({ safe: "prefix password\\=decoded-short-secret" }),
    ],
    [
      "nested Unicode escape known-prefix candidate",
      '{"safe":"sk\\\\u002dabcdefghijklmnop"}',
    ],
    [
      "multi-backslash Unicode escape known-prefix candidate",
      '{"safe":"sk\\\\\\\\u002dabcdefghijklmnop"}',
    ],
    [
      "nested Unicode escape assignment candidate",
      '{"safe":"prefix password\\\\u003dshort-9"}',
    ],
    [
      "synthesized residual escape known-prefix candidate",
      '{"safe":"sk\\\\u005cu002dabcdefghijklmnop"}',
    ],
    [
      "synthesized residual escape Bearer candidate",
      '{"safe":"Bearer\\\\u005cu0020short-secret"}',
    ],
    [
      "synthesized residual escape long-token candidate",
      `{"safe":"${"A".repeat(31)}\\\\u005cu0041"}`,
    ],
    [
      "repeated synthesized residual escape candidate",
      '{"safe":"sk\\\\u005c\\\\u002dabcdefghijklmnop"}',
    ],
    [
      "decoded quote-fragment assignment candidate",
      JSON.stringify({ safe: 'pass"word"=HIDDEN_QFRAG' }),
    ],
    [
      "decoded quote-fragment Bearer candidate",
      JSON.stringify({ safe: 'Bear"er" HIDDEN_QFRAG' }),
    ],
    [
      "decoded quote-fragment known-prefix candidate",
      JSON.stringify({ safe: 'sk"-"abcdefghijkl' }),
    ],
    [
      "decoded quote-fragment long-token candidate",
      JSON.stringify({
        safe: `aaaaaaaaaaaaaaaa"a"aaaaaaaaaaaaaaaa`,
      }),
    ],
    [
      "canonical plus decoded quote-fragment assignment candidate",
      JSON.stringify({
        safe: 'password=[REDACTED] pass"word"=HIDDEN_QFRAG',
      }),
    ],
    [
      "decoded comment-fragment assignment candidate",
      JSON.stringify({
        safe: "pass/*join*/word=HIDDEN_COMMENT_FRAGMENT",
      }),
    ],
    [
      "decoded comment-fragment Bearer candidate",
      JSON.stringify({
        safe: "Bear/*join*/er HIDDEN_COMMENT_FRAGMENT",
      }),
    ],
    [
      "decoded comment-fragment known-prefix candidate",
      JSON.stringify({
        safe: "sk/*join*/-abcdefghijkl",
      }),
    ],
    [
      "decoded comment-fragment long-token candidate",
      JSON.stringify({
        safe: `${"a".repeat(16)}/*join*/${"a".repeat(16)}`,
      }),
    ],
  ])("fails closed for a decoded-string sensitive candidate: %s", (_case, input) => {
    expect(redactText(input)).toBe("[REDACTED]");
  });

  it.each([
    "https://example.test//sk\\u002dabcdefghijkl",
    "https://example.test/path?next=//sk\\u002dabcdefghijkl",
    "file:////host/sk\\u002dabcdefghijkl",
    "note /* sk\\u002dabcdefghijkl",
    "note /* sk\\u002dabcdefghijkl */",
    "note // sk\\u002dabcdefghijkl",
  ])("fails closed for a projected token in URL or comment text: %s", (input) => {
    expect(redactText(input)).toBe("[REDACTED]");
  });

  it.each([
    "sk\\x2dabcdefghijkl",
    "Bearer\\x20short-secret",
    "password\\x3dshort-secret",
  ])(
    "fails closed for a hexadecimal-escaped sensitive candidate: %s",
    (input) => {
      expect(redactText(input)).toBe("[REDACTED]");
    },
  );

  it.each([
    '{"safe":"sk-abcdefghijkl\\u005aTOPSECRET"}',
    '{"safe":"sk-abcdefghijkl\\\\u005aTOPSECRET"}',
    '{"safe":"sk-abcdefghijkl\\\\x5aTOPSECRET"}',
  ])(
    "fails closed when decoding extends a known-prefix token suffix: %s",
    (input) => {
      expect(redactText(input)).toBe("[REDACTED]");
    },
  );

  it("precisely redacts one complete raw known-prefix token suffix", () => {
    const input =
      "prefix sk-abcdefghijklZTOPSECRET safe=keep";

    expect(redactText(input)).toBe(
      "prefix [REDACTED] safe=keep",
    );
  });

  it.each(
    [1, 3, 12].flatMap((backslashCount) => {
      const joiner = "\\".repeat(backslashCount);
      return [
        `sk${joiner}x2dabcdefghijkl`,
        `Bearer${joiner}x20short-secret`,
        `password${joiner}x3dshort-secret`,
      ];
    }),
  )(
    "fails closed across hexadecimal residual escape parity: %s",
    (input) => {
      expect(redactText(input)).toBe("[REDACTED]");
    },
  );

  it.each([
    "sk\\x5cx2dabcdefghijkl",
    "Bearer\\x5cx20short-secret",
    "password\\x5cx3dshort-secret",
  ])(
    "fails closed across a synthesized hexadecimal escape chain: %s",
    (input) => {
      expect(redactText(input)).toBe("[REDACTED]");
    },
  );

  it.each(
    Array.from({ length: 12 }, (_, index) => index + 1).flatMap(
      (backslashCount) => {
        const joiner = "\\".repeat(backslashCount);
        return [
          [
            `known-prefix with ${backslashCount} backslashes`,
            `{"safe":"sk${joiner}u002dabcdefghijklmnop"}`,
          ],
          [
            `Bearer separator with ${backslashCount} backslashes`,
            `{"safe":"Bearer${joiner}u0020short-secret"}`,
          ],
          [
            `long token with ${backslashCount} backslashes`,
            `{"safe":"${"A".repeat(31)}${joiner}u0041"}`,
          ],
        ] as const;
      },
    ),
  )("fails closed across residual escape parity: %s", (_case, input) => {
    expect(redactText(input)).toBe("[REDACTED]");
  });

  it.each(Array.from({ length: 8 }, (_, index) => index + 1))(
    "fails closed across a synthesized escape chain of length %i",
    (chainLength) => {
      const chain =
        "\\\\" + "u005c".repeat(chainLength) + "u002d";
      const input =
        `{"safe":"sk${chain}` +
        'abcdefghijklmnop"}';

      expect(redactText(input)).toBe("[REDACTED]");
    },
  );

  it.each([1, 3, 12])(
    "precisely covers a direct sensitive value with %i backslashes",
    (backslashCount) => {
      const joiner = "\\".repeat(backslashCount);
      const input =
        `{"password":"sk${joiner}u002dabcdefghijklmnop",` +
        '"safe":"keep"}';

      expect(redactText(input)).toBe(
        '{"password":"[REDACTED]","safe":"keep"}',
      );
    },
  );

  it.each([
    [
      "Bearer candidate",
      JSON.stringify({ safe: "prefix Bearer decoded-short-secret" }),
      '{"safe":"prefix Bearer [REDACTED]"}',
    ],
    [
      "known-prefix candidate",
      JSON.stringify({ safe: "prefix sk-abcdefghijkl suffix" }),
      '{"safe":"prefix [REDACTED] suffix"}',
    ],
    [
      "long key-like candidate",
      JSON.stringify({ safe: `prefix ${"a".repeat(32)} suffix` }),
      '{"safe":"prefix [REDACTED] suffix"}',
    ],
    [
      "known-prefix candidate after an unrelated escaped path",
      JSON.stringify({
        safe: "C:\\workspace prefix sk-abcdefghijkl suffix",
      }),
      JSON.stringify({
        safe: "C:\\workspace prefix [REDACTED] suffix",
      }),
    ],
    [
      "Bearer candidate after an unrelated escaped quote",
      JSON.stringify({
        safe: 'said "hello" then Bearer raw-short-secret',
      }),
      JSON.stringify({
        safe: 'said "hello" then Bearer [REDACTED]',
      }),
    ],
    [
      "known-prefix candidate after an unrelated escaped newline",
      JSON.stringify({
        safe: "line\nbefore sk-abcdefghijkl suffix",
      }),
      JSON.stringify({
        safe: "line\nbefore [REDACTED] suffix",
      }),
    ],
  ])(
    "precisely redacts a decoded candidate whose raw offsets are reliable: %s",
    (_case, input, expected) => {
      expect(redactText(input)).toBe(expected);
    },
  );

  it.each([
    JSON.stringify({ safe: 'C:\\workspace\\file.ts said "hello"' }),
    JSON.stringify({ safe: "ordinary token budget and password guidance" }),
  ])("preserves a decoded safe string without a sensitive candidate: %s", (input) => {
    expect(redactText(input)).toBe(input);
  });

  it("normalizes an ordinary line continuation without whole redaction", () => {
    const input = ["ordinary", "\\", "\n", "continued text"].join("");

    expect(redactText(input)).toBe("ordinary\\continued text");
  });

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
    JSON.stringify({
      safe: "Be\u200Barer\nopaque-short-secret-9001",
    }),
    JSON.stringify({
      safe: 'Be""arer\nopaque-short-secret-9001',
    }),
  ])(
    "fails closed for a Bearer candidate split by decoded provenance: %s",
    (input) => {
      expect(redactText(input)).toBe("[REDACTED]");
    },
  );

  it.each([
    [
      "block comment",
      "Bearer/*x*/short-secret",
    ],
    [
      "empty block comment",
      "Bearer/**/short-secret",
    ],
    [
      "line comment",
      "Bearer//x\nshort-secret",
    ],
    [
      "JSON safe string",
      JSON.stringify({
        safe: "Bearer/*x*/short-secret",
      }),
    ],
    [
      "Unicode-escaped block comment",
      "Bearer\\u002f\\u002ax\\u002a\\u002fshort-secret",
    ],
    [
      "hexadecimal-escaped block comment",
      "Bearer\\x2f\\x2ax\\x2a\\x2fshort-secret",
    ],
    [
      "JSON residual Unicode block comment",
      JSON.stringify({
        safe:
          "Bearer\\u002f\\u002ax\\u002a\\u002fshort-secret",
      }),
    ],
    [
      "Unicode-escaped line comment",
      "Bearer\\u002f\\u002fx\\u000ashort-secret",
    ],
  ])(
    "fails closed when %s separates Bearer from its token",
    (_case, input) => {
      expect(redactText(input)).toBe("[REDACTED]");
    },
  );

  it.each([
    "Bearer [REDACTED]",
    "Authorization: Bearer [REDACTED]",
    '{"safe":"Bearer [REDACTED]"}',
  ])("preserves a canonical Bearer redaction: %s", (input) => {
    expect(redactText(input)).toBe(input);
  });

  it.each([
    '{"safe":"password=[REDACTED]"}',
    '{"safe":"prefix [REDACTED] suffix"}',
  ])("preserves another canonical decoded redaction: %s", (input) => {
    expect(redactText(input)).toBe(input);
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
    expect(redactText(input)).toBe("[REDACTED]");
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("keeps repeated decoded unterminated comments within a linear-time margin", () => {
    const unit = "password\\u002f\\u002a ";
    const head = `{"safe":"${unit.repeat(2_978)}"}`;
    const input = head + "x".repeat(65_536 - head.length);
    const startedAt = performance.now();

    expect(input).toHaveLength(65_536);
    expect(redactText(input)).toBe("[REDACTED]");
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("keeps repeated quoted sensitive comment gaps within a linear-time margin", () => {
    const input = '"password"/*'.repeat(5_400) + "*/x";
    const startedAt = performance.now();

    expect(input.length).toBeLessThanOrEqual(65_536);
    expect(redactText(input)).toBe("[REDACTED]");
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("keeps quote-rejoined shared comment gaps within a linear-time margin", () => {
    const input =
      ('"password"/"*" ').repeat(4_368) +
      '"*"/"="x';
    const startedAt = performance.now();

    expect(input.length).toBeGreaterThan(65_000);
    expect(input.length).toBeLessThanOrEqual(65_536);
    expect(redactText(input)).toBe("[REDACTED]");
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  it("keeps repeated known prefixes in one token run within a linear-time margin", () => {
    const input = "-sk-abcdefghijkl".repeat(4_096);
    const startedAt = performance.now();

    expect(input).toHaveLength(65_536);
    expect(redactText(input)).toBe("[REDACTED]");
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
