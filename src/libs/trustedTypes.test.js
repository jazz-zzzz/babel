function loadTrustedTypesHelper({ trustedTypes } = {}) {
  jest.resetModules();

  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
  };

  jest.doMock("./log", () => ({ logger }));

  Object.defineProperty(globalThis, "trustedTypes", {
    configurable: true,
    value: trustedTypes,
  });

  const { trustedTypesHelper } = require("./trustedTypes");
  return { trustedTypesHelper, logger };
}

describe("trustedTypesHelper", () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.dontMock("./log");
    delete globalThis.trustedTypes;
    document.body.innerHTML = "";
  });

  test("falls back quietly and sanitizes HTML when the page CSP blocks the policy name", () => {
    const blockedByCspError = new TypeError(
      "Creating a TrustedTypePolicy named 'babel-policy' violates the following Content Security policy directive: \"trusted-types twKxV6 default\"."
    );
    const trustedTypes = {
      createPolicy: jest.fn(() => {
        throw blockedByCspError;
      }),
    };

    const { trustedTypesHelper, logger } = loadTrustedTypesHelper({
      trustedTypes,
    });

    const html = trustedTypesHelper.createHTML(
      '<img src="x" onerror="alert(1)"><span onclick="alert(2)">ok</span>'
    );

    expect(trustedTypesHelper.isEnabled()).toBe(false);
    expect(String(html)).toContain("<span>ok</span>");
    expect(String(html)).not.toContain("onerror");
    expect(String(html)).not.toContain("onclick");
    expect(logger.info).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("sets sanitized HTML through a DOM fallback when string innerHTML is rejected", () => {
    const trustedTypes = {
      createPolicy: jest.fn(() => {
        throw new TypeError("This document requires 'TrustedHTML' assignment.");
      }),
    };
    const { trustedTypesHelper } = loadTrustedTypesHelper({ trustedTypes });
    const el = document.createElement("div");

    Object.defineProperty(el, "innerHTML", {
      configurable: true,
      get: () => "",
      set: () => {
        throw new TypeError("This document requires 'TrustedHTML' assignment.");
      },
    });

    expect(() => {
      trustedTypesHelper.setHTML(
        el,
        '<span onclick="alert(1)">ok</span><img src="x" onerror="alert(2)">'
      );
    }).not.toThrow();

    expect(el.querySelector("span").textContent).toBe("ok");
    expect(el.querySelector("span").hasAttribute("onclick")).toBe(false);
    expect(el.querySelector("img").hasAttribute("onerror")).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
