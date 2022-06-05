import Toybox.Test;
import Toybox.Lang;

var z as Number = 0;

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

        (:inline)
        function s1(y as Number) as Void {
            x += y;
            a();
        }
        (:inline)
        function s2(y as Number) as Void {
            z += y;
        }
        (:inline)
        function s3(y as Number) as Number {
            z += y;
            return z;
        }
        (:inline)
        function s4(y as Number) as Number {
            z += y;
            return a();
        }
        (:inline)
        function s5(y as Number) as Number {
            y += 3;
            z += y;
            return a();
        }
    }
    var x as Number = 1000;
    const K as Number = B.x;
}

var ok as Boolean = false;
function check(x as Number, expected as Number, logger as Logger) as Void {
    if (x != expected) {
        logger.debug(
            "Got " + x + " Should be " + expected + " (B.x = " + A.B.x + ")"
        );
        ok = false;
    }
}

(:test)
function inlineAsExpressionTests(logger as Logger) as Boolean {
    ok = true;
    A.B.x = 0;
    var x = 0;
    x = /* @match A.B.a */ A.B.f(1);
    check(x, 2, logger);
    x = /* @match A.B.a */ A.B.f(x);
    check(x, 4, logger);
    x = /* @match A.B.a */ A.B.f(A.K);
    check(x, 3, logger);
    // Should fail to inline, because A.B.x might
    // be modified before its used in the body of f
    // The +1 is to prevent the statement inliner
    // from inlining it.
    x = /* @match A.B.f */ A.B.f(A.B.x) + 1;
    check(x, 8, logger);

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
    x = /* @match A.B.h */ A.B.h(A.B.a()) + 1;
    check(x, 11, logger);

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

    x = /* @match A.B.j */ A.B.j(1) + 1;
    check(x, 3, logger);
    x = /* @match A.B.j */ A.B.j(x) + 1;
    check(x, 5, logger);
    x = /* @match A.B.j */ A.B.j(A.K) + 1;
    check(x, 4, logger);
    x = /* @match A.B.j */ A.B.j(A.B.x) + 1;
    check(x, 8, logger);
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

(:test)
function inlineAsStatementTests(logger as Logger) as Boolean {
    ok = true;
    z = 0;
    A.B.x = 0;
    var x = 0;

    /* @match /A.B.x \+= 1/ */
    A.B.s1(1);
    check(A.B.x, 2, logger);
    {
        var y = 0;
        /* @match /A.B.x \+= A.B.x/ */
        A.B.s1(A.B.x);
        check(A.B.x, 5, logger);
        /* @match /var \w+y\w+ = A.B.a\(\)/ */
        A.B.s1(A.B.a());
        check(A.B.x, 13, logger);
    }
    /* @match /^\{\s*z\s*\+=\s*5;\s*\}$/ */
    A.B.s2(5);
    check(z, 5, logger);
    {
        var z = 2;
        /* @match /^\{\s*\$.z\s*\+=\s*3;\s*\}$/ */
        A.B.s2(3);
        check($.z, 8, logger);
        /* @match /^\{\s*\$.z\s*\+=\s*A\.B\.x;\s*\}$/ */
        A.B.s3(A.B.x);
        check($.z, 21, logger);
        /* @match /^\{\s*\$.z\s*\+=\s*z;\s*A.B.a\(\);\s*\}$/ */
        A.B.s4(z);
        check($.z, 23, logger);
    }
    /* @match "var y = 3;" */
    A.B.s5(3);
    check(z, 29, logger);
    return ok;
}

(:test)
function unusedExpressionCleanupTests(logger as Logger) as Boolean {
    ok = true;
    A.B.x = 0;

    /* @match /^check/ */
    [1, 2, 3];
    check(A.B.x, 0, logger);
    /* @match /^A.B.a/ /^check/ */
    [1, A.B.a(), 3];
    check(A.B.x, 1, logger);
    /* @match /^A.B.a/ /^check/ */
    { A.B.a() => A.B.x, "x" => 42 };
    check(A.B.x, 2, logger);
    /* @match /^A.B.a/ /^A.B.s1/ /^check/ */
    ((A.B.a() || 3) * (A.B.s1(A.B.x) || 4));
    check(A.B.x, 7, logger);
    return ok;
}

(:inline)
function multipleReturns(y as Number) as Number {
    if (y > 3) {
        return 42;
    }
    return y * 9;
}

(:inline)
function multipleReturnsNoFinalReturn(y as Number) as Number {
    if (y > 3) {
        return 42;
    } else {
        return y * 9;
    }
}

function testMultipleReturns(y as Number) as Number {
    /* @match /^\{.*\}$/ */
    return multipleReturns(y);
}

function testMultipleReturnsNoFinalReturn(y as Number) as Number {
    /* @match "return multipleReturnsNoFinalReturn(y);" */
    return multipleReturnsNoFinalReturn(y);
}

(:test)
function inlineReturnContext(logger as Logger) as Boolean {
    var x;
    ok = true;
    A.B.x = 0;
    A.B.a();
    x = testMultipleReturns(A.B.x);
    check(x, 9, logger);
    x = testMultipleReturns(9);
    check(x, 42, logger);
    x = testMultipleReturnsNoFinalReturn(A.B.x);
    check(x, 9, logger);
    x = testMultipleReturnsNoFinalReturn(9);
    check(x, 42, logger);
    return ok;
}

(:inline)
function assignContext(x as Number) as Number {
    x++;
    return x * z;
}

(:test)
function inlineAssignContext(logger as Logger) as Boolean {
    var x;
    ok = true;
    A.B.x = 4;
    z = 3;
    /* @match /var \w+x\w+ = 1;/ */
    x = assignContext(1);
    check(x, 6, logger);
    /* @match /var \w+x\w+ = z;/ */
    x = assignContext(z);
    check(x, 12, logger);
    var z = 15;
    /* @match /\* \$\.z;\s*\}/ */
    x = assignContext(A.B.x);
    check(x, 15, logger);
    return ok;
}
