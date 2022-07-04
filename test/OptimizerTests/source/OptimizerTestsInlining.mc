import Toybox.Test;
import Toybox.Lang;

var z as Number = 0;

module A {
    module B {
        const K1 = 1;
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
        (:inline_size)
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

function nonInlinedWrapper(v as Number) as Number {
    var ret = /* @match A.B.a */ A.B.f(v);
    return ret;
}

function inlineHiddenByLocal(v as Number) as Number {
    return v;
}

(:inline)
function doubleSubstitution(v as Logger?) as Logger or Boolean {
    return v != null ? v : false;
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
    x = /* @match /^([\w.]+x) \+ \1/ */ A.B.h(A.B.x);
    check(x, 8, logger);
    x = /* @match A.B.h */ A.B.h(A.B.a()) + 1;
    check(x, 11, logger);

    // i can be inlined regardless of arguments
    x = /* @match @^A\.B\.a\(\)$@ */ A.B.i(A.B.a());
    check(x, 6, logger);
    x = nonInlinedWrapper(1);
    check(x, 8, logger);

    /* @match /^var inlineHiddenByLocal = A.B.x;$/ */
    var inlineHiddenByLocal = inlineHiddenByLocal(A.B.x);
    check(inlineHiddenByLocal, 7, logger);

    /* @match /^x = A\.B\.a\(\);$/ */
    x = inlineNeedsLocalImport();
    check(x, 8, logger);

    /* @match /^x = .*\? Toybox.Application.Storage.getValue/ */
    x = inlineNeedsToyboxImport();
    check(x == null ? 1 : 0, 1, logger);

    /* @match /^var lg = logger \!= null \?/ */
    var lg = doubleSubstitution(logger);
    check((lg as Logger) == logger ? 1 : 0, 1, logger);
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
    check(x, 6, logger);
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
    /* @match /^\{ z \+= @5; \}$/ */
    A.B.s2(5);
    check(z, 5, logger);
    {
        var z = 2;
        /* @match /^\{ self.z \+= @3; \}$/ */
        A.B.s2(3);
        check($.z, 8, logger);
        /* @match /^\{ self.z \+= A\.B\.x; \}$/ */
        A.B.s3(A.B.x);
        check($.z, 21, logger);
        /* @match /^\{ self.z \+= z; A.B.a\(\); \}$/ */
        A.B.s4(z);
        check($.z, 23, logger);
    }
    /* @match /var y = @3;/ */
    A.B.s5(3);
    check(z, 29, logger);
    return ok;
}

(:inline)
function unusedArray1() as Array {
    return [1, 2, 3];
}

(:inline)
function unusedArray2() as Array {
    return [1, A.B.a(), 3];
}

(:inline)
function unusedObject() as Dictionary {
    return { A.B.a() => A.B.x, "x" => 42 };
}

(:inline)
function unusedLogicals() as Number {
    return (
        (A.B.a() || 3) * (A.B.s1(A.B.x) || 4) +
        (A.B.x != 0 ? A.B.s1(1) : A.B.x) +
        (A.B.x != 0 && A.B.s1(1)) +
        (A.B.x == 0 || A.B.s1(1))
    );
}

(:test)
function unusedExpressionCleanupTests(logger as Logger) as Boolean {
    ok = true;
    A.B.x = 0;

    /* @match /^check/ */
    unusedArray1();
    check(A.B.x, 0, logger);
    /* @match /^A.B.a/ /^check/ */
    unusedArray2();
    check(A.B.x, 1, logger);
    /* @match /^A.B.a/ /^check/ */
    unusedObject();
    check(A.B.x, 2, logger);
    /* @match /^A.B.a\(\);/ /\{.*?\}/ /if \(A.B.x != @0\) \{.*?\}/ /if \(A.B.x != @0\) \{.*\}/ /if \(A.B.x == @0\) \{ \} else \{/ /^check/ */
    unusedLogicals();
    check(A.B.x, 13, logger);
    return ok;
}

(:inline)
function multipleReturns(y as Number) as Number {
    /* @match This should have been removed */
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

// prettier-ignore
function testMultipleReturns(y as Number) as Number {
    /* @match /^if \(y > 3\)/ */
    return multipleReturns(y);
}

function testMultipleReturnsNoFinalReturn(y as Number) as Number {
    /* @match "return multipleReturnsNoFinalReturn(y);" */
    return multipleReturnsNoFinalReturn(y);
}

module Wrapper {
    var z as Number = 5000;
    (:test)
    function inlineReturnContext(logger as Logger) as Boolean {
        var x;
        ok = true;
        A.B.x = 0;
        z = 0;
        A.B.a();
        x = testMultipleReturns(A.B.x);
        check(x, 9, logger);
        x = testMultipleReturns(9);
        check(x, 42, logger);
        x = testMultipleReturnsNoFinalReturn(A.B.x);
        check(x, 9, logger);
        x = testMultipleReturnsNoFinalReturn(9);
        check(x, 42, logger);
        {
            var z = 2;
            /* @match /^\{ \$.z \+= 3; \}$/ */
            A.B.s2(3);
            check($.z, 3, logger);
        }
        return ok;
    }
}

(:inline)
function assignContext(x as Number) as Number {
    /* @match This should have been removed */
    x++;
    return assignContext2(x);
}

(:inline)
function assignContext2(x as Number) as Number {
    /* @match This should have been removed */
    var tmp = x * z;
    return tmp;
}

(:test) // foo
function inlineAssignContext(logger as Logger) as Boolean {
    var x;
    ok = true;
    A.B.x = 4;
    z = 3;
    var arr = [1, 2, 3];

    /* @match /var \w+x\w+ = 1;/ */
    x = assignContext(1);
    check(x, 6, logger);
    /* @match /var \w+x\w+ = z;/ */
    x = assignContext(z);
    check(x, 12, logger);
    {
        var z = 15;
        /* @match /\* self\.z;/ */
        x = assignContext(A.B.x);
        check(x, 15, logger);
    }
    /* @match /^z \+= A.B.s3/ */
    z += A.B.s3(2);
    check(z, 8, logger);
    /* @match /z \+= @2/ */
    z = A.B.s3(2);
    check(z, 10, logger);

    /* @match "var a;" /z \+= @2; a = z;/ */
    var a = A.B.s3(2);
    check(a, 12, logger);

    /* @match "var b = 42, c;" /z \+= @3/ "var d;" /\w+x\w+ \* z;/ /var e = @42;/ */
    var b = 42,
        c = A.B.s3(3),
        d = assignContext(1),
        e = 42;
    check(c, 15, logger);
    check(d, 30, logger);

    // inlining here would require a lot of gymnastics. Don't allow it
    // for now.
    /* @match /^for / */
    for (
        var f = 42, g = A.B.s3(3), h = A.B.s3(4), i = 42;
        f < 42;
        f++, g = A.B.s3(3)
    ) {}

    z = 0;
    /* @match /A.B.s3/ */
    arr[z] = A.B.s3(1);
    check(arr[0] as Number, 1, logger);

    return ok;
}

import Toybox.Activity;
import Toybox.Lang;

class Foo {
    var mHR as Number = 123;
    var mB as Number = 0;

    function initialize() {
        compute();
    }

    public function compute() as Void {
        var extHr = foofoo();
    }

    (:inline)
    hidden function barbar(heartRate as Number) as Void {
        /* @match This should be removed */
        mB = 1;
    }

    (:inline)
    hidden function foofoo() as String or Number {
        /* @match This should be removed */
        var result = "?";
        var heartRate = mHR;
        var isValidHR = true;
        if (isValidHR) {
            barbar(heartRate);
        }
        return result;
    }
}