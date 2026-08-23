import { assert, expect } from "chai";
import { formatAst } from "../../src/api";
import { optimizeMonkeyC } from "../../src/mc-rewrite";
import { BuildConfig, FilesToOptimizeMap } from "../../src/optimizer-types";

function optimize(source: string, config: BuildConfig): Promise<string> {
  const filename = "test.mc";
  const fnMap: FilesToOptimizeMap = {
    [filename]: {
      name: filename,
      monkeyCSource: source,
      output: "",
      excludeAnnotations: {},
      barrel: "",
    },
  };
  return optimizeMonkeyC(fnMap, {}, undefined, config).then(() =>
    formatAst(fnMap[filename].ast!)
  );
}

/*
 * The release pattern from issue #91: a large object deliberately
 * freed with an explicit `x = null' store before a memory-tight
 * window, with a predicate captured beforehand so the object is not
 * otherwise referenced again.
 */
const releasePattern = `
import Toybox.Lang;
import Toybox.System;

module DeadStoreTest {
  function build() as Array<Number>? {
    return [1, 2, 3] as Array<Number>;
  }
  (:test)
  function releaseBeforeWindow() as Number {
    var parts = build();
    System.println(parts);
    var armed = parts != null;
    parts = null;
    System.println("window");
    if (armed) {
      return 1;
    }
    return 0;
  }
}
`;

const baseConfig: BuildConfig = {
  trustDeclaredTypes: true,
  propagateTypes: true,
  sizeBasedPRE: true,
  minimizeLocals: true,
  singleUseCopyProp: true,
  checkTypes: "WARNING",
};

export function deadStoreTests() {
  describe("preserveNullAssignments", () => {
    it("by default the explicit null store is a dead store, and is removed", () =>
      optimize(releasePattern, { ...baseConfig }).then((output) => {
        expect(output).to.not.match(/\w+ = null;/);
      }));

    it("with the option, the explicit null store survives", () =>
      optimize(releasePattern, {
        ...baseConfig,
        preserveNullAssignments: true,
      }).then((output) => {
        expect(output).to.match(/\w+ = null;/);
      }));

    it("with the option, copy prop does not extend the live range across the null store", () =>
      optimize(releasePattern, {
        ...baseConfig,
        preserveNullAssignments: true,
      }).then((output) => {
        // the captured predicate must not be folded back into a
        // `!= null' test of the released variable at its use, past
        // the release point
        const store = output.search(/\w+ = null;/);
        const test = output.indexOf("!= null");
        assert(store >= 0, "expected the null store to survive");
        assert(test >= 0, "expected the captured predicate to survive");
        assert(
          test < store,
          "the != null test must stay before the release point"
        );
      }));
  });
}
