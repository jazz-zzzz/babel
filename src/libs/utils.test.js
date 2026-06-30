const { decodeHTMLEntities } = require("./utils");

describe("decodeHTMLEntities", () => {
  test("decodes named, decimal, and hexadecimal HTML entities without DOM sinks", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "innerHTML"
    );

    Object.defineProperty(HTMLTextAreaElement.prototype, "innerHTML", {
      configurable: true,
      get: () => "",
      set: () => {
        throw new TypeError("This document requires 'TrustedHTML' assignment.");
      },
    });

    try {
      expect(
        decodeHTMLEntities(
          "Tom &amp; Jerry&#10;&#x1F600; &lt;b&gt;text&lt;/b&gt; That&rsquo;s it."
        )
      ).toBe("Tom & Jerry\n😀 <b>text</b> That’s it.");
    } finally {
      if (descriptor) {
        Object.defineProperty(
          HTMLTextAreaElement.prototype,
          "innerHTML",
          descriptor
        );
      } else {
        delete HTMLTextAreaElement.prototype.innerHTML;
      }
    }
  });

  test("keeps non-string values unchanged", () => {
    expect(decodeHTMLEntities(null)).toBe(null);
  });
});
