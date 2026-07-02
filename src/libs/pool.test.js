describe("fetch pools", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test("keeps subtitle requests on an independent pool", () => {
    const { getFetchPool } = require("./pool");

    const pagePool = getFetchPool(100, 10);
    const subtitlePool = getFetchPool(10, 30, "subtitle");

    expect(subtitlePool).not.toBe(pagePool);
    expect(getFetchPool(10, 30, "subtitle")).toBe(subtitlePool);
    expect(getFetchPool(100, 10)).toBe(pagePool);
  });
});
