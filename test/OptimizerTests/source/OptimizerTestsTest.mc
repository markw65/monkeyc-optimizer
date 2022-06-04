import Toybox.Test;
import Toybox.Lang;

module A {
  module B {
    var x as Number = 0;
    function a() as Number {
      x++;
      return x;
    }
    (:inline)
    function f(x as Number) as Number {
      return a() + x;
    }
    (:inline)
    function g(x as Number) as Number {
      return x + a();
    }
    (:inline)
    function h(x as Number) as Number {
      return x + x;
    }
    // This should auto-inline regardless of
    // arguments.
    function i(x as Number) as Number {
      return x;
    }
    (:inline_speed)
    function j(x as Number) as Number {
      return x + a();
    }
  }
  var x as Number = 1000;
  const K as Number = B.x;
}

var ok as Boolean = false;
function check(x as Number, expected as Number, logger as Logger) as Void {
  if (x != expected) {
    logger.debug(
      "x = " + x + " Should be " + expected + "(B.x = " + A.B.x + ")"
    );
    ok = false;
  }
}

(:test)
function inlineTests(logger as Logger) as Boolean {
  ok = true;
  A.B.x = 0;
  var x = 0;
  x = /* @match A.B.a */ A.B.f(1);
  check(x, 2, logger);
  x = /* @match A.B.a */ A.B.f(x);
  check(x, 4, logger);
  x = /* @match A.B.a */ A.B.f(A.K);
  check(x, 3, logger);
  x = /* @match A.B.f */ A.B.f(A.B.x);
  check(x, 7, logger);

  A.B.x = 0;
  x = /* @match A.B.a */ A.B.g(1);
  check(x, 2, logger);
  x = /* @match A.B.a */ A.B.g(x);
  check(x, 4, logger);
  x = /* @match A.B.a */ A.B.g(A.K);
  check(x, 3, logger);
  x = /* @match A.B.a */ A.B.g(A.B.x);
  check(x, 7, logger);

  A.B.x = 4;
  // h can be inlined unless its argument has side effects.
  x = /* @match 2 */ A.B.h(1);
  check(x, 2, logger);
  x = /* @match "A.B.x + A.B.x" */ A.B.h(A.B.x);
  check(x, 8, logger);
  x = /* @match A.B.h */ A.B.h(A.B.a());
  check(x, 10, logger);

  // i can be inlined regardless of arguments
  x = /* @match @^A\.B\.a\(\)$@ */ A.B.i(A.B.a());
  check(x, 6, logger);
  return ok;
}

/*
 * j is only inlined when speed is defined, and this function
 * is removed when its defined.
 *
 * So j should not be inlined here.
 */
(:test,:speed)
function inlineSizeTests(logger as Logger) as Boolean {
  ok = true;
  A.B.x = 0;
  var x;

  x = /* @match A.B.j */ A.B.j(1);
  check(x, 2, logger);
  x = /* @match A.B.j */ A.B.j(x);
  check(x, 4, logger);
  x = /* @match A.B.j */ A.B.j(A.K);
  check(x, 3, logger);
  x = /* @match A.B.j */ A.B.j(A.B.x);
  check(x, 7, logger);
  return ok;
}

/*
 * j is only inlined when speed is defined, and speed and
 * size are configured to be mutually exclusive.
 *
 * So j should be inlined here.
 */
(:test,:size)
function inlineSpeedTests(logger as Logger) as Boolean {
  ok = true;
  A.B.x = 0;
  var x;

  x = /* @match A.B.a */ A.B.j(1);
  check(x, 2, logger);
  x = /* @match A.B.a */ A.B.j(x);
  check(x, 4, logger);
  x = /* @match A.B.a */ A.B.j(A.K);
  check(x, 3, logger);
  x = /* @match A.B.a */ A.B.j(A.B.x);
  check(x, 7, logger);
  return ok;
}
