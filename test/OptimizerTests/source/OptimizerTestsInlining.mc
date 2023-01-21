import Toybox.Test;
import Toybox.Lang;
import Toybox.Math;

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

function getinst(
    x as Number or Long or Float or Double or String or Char
) as String {
    return x instanceof Lang.Number
        ? "Number"
        : x instanceof Lang.Long
        ? "Long"
        : x instanceof Lang.Float
        ? "Float"
        : x instanceof Lang.Double
        ? "Double"
        : x instanceof Lang.String
        ? "String"
        : x instanceof Lang.Char
        ? "Char"
        : "<unknown>";
}

const FLOAT_EPSILON = Math.pow(2, -23);
const DOUBLE_EPSILON = Math.pow(2, -52);

var ok as Boolean = false;
function check(
    x as Number or Long or Float or Double or String or Char,
    expected as Number or Long or Float or Double or String or Char,
    logger as Logger
) as Void {
    checker(x, expected, logger, false);
}

function checker(
    x as Number or Long or Float or Double or String or Char,
    expected as Number or Long or Float or Double or String or Char,
    logger as Logger,
    isFloat as Boolean
) as Void {
    var xinst = getinst(x);
    var einst = getinst(expected);
    if (
        isFloat
            ? ((x as Numeric) - (expected as Numeric)).abs() >
              (einst.equals("Float") ? FLOAT_EPSILON : DOUBLE_EPSILON) *
                  (expected as Numeric).abs()
            : !x.equals(expected)
    ) {
        logger.debug(
            "Got " +
                x +
                "<" +
                xinst +
                "> Should be " +
                expected +
                "<" +
                einst +
                "> (B.x = " +
                A.B.x +
                ")"
        );
        if (isFloat) {
            logger.debug(
                "    - Difference = " +
                    ((x as Numeric) - (expected as Numeric)).format("%.17f")
            );
            logger.debug(
                "    - Epsilon = " +
                    (
                        (einst.equals("Float")
                            ? FLOAT_EPSILON
                            : DOUBLE_EPSILON) * (expected as Numeric).abs()
                    ).format("%.17f")
            );
        }
        ok = false;
    }
    if (!xinst.equals(einst)) {
        logger.debug(
            "Wrong types " +
                xinst +
                " Should be " +
                einst +
                " (B.x = " +
                A.B.x +
                ")"
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
function doubleSubstitution(v as Logger?) as Logger or Boolean or Null {
    return v != gLogger ? v : false;
}

var gOne as Number = 1;

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
    // The gOne's are to prevent the statement inliner
    // from inlining it.
    /* @match A.B.f */
    x = gOne + A.B.f(A.B.x) + gOne;
    check(x, 9, logger);

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
    x = /* @match /^@8$/ */ A.B.h(A.B.x);
    check(x, 8, logger);
    x = /* @match A.B.h */ A.B.h(A.B.a()) + 1;
    check(x, 11, logger);

    // i can be inlined regardless of arguments
    x = /* @match @^A\.B\.a\(\)$@ */ A.B.i(A.B.a());
    check(x, 6, logger);
    x = nonInlinedWrapper(1);
    check(x, 8, logger);

    /* @match /^var inlineHiddenByLocal = (A.B.x|pre_x\w*);$/ */
    var inlineHiddenByLocal = inlineHiddenByLocal(A.B.x);
    check(inlineHiddenByLocal, 7, logger);

    /* @match /^x = A\.B\.a\(\);$/ */
    x = inlineNeedsLocalImport();
    check(x, 8, logger);

    /* @match /^x = .*\? Toybox.Application.Storage.getValue/ */
    x = inlineNeedsToyboxImport();
    check(x == null ? 1 : 0, 1, logger);

    /* @match /^var lg = logger \!= @gLogger \?/ */
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
    /* @match /^z \+= @5;$/ */
    A.B.s2(5);
    check(z, 5, logger);
    {
        var z = 2;
        /* @match /^self.z \+= @3;$/ */
        A.B.s2(3);
        check($.z, 8, logger);
        /* @match /^self.z \+= A\.B\.x;$/ */
        A.B.s3(A.B.x);
        check($.z, 21, logger);
        /* @match /^self.z \+= @2;$/ /^A.B.a\(\);$/ */
        A.B.s4(z);
        check($.z, 23, logger);
    }
    /* @match /z \+= @6;/ */
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
function unusedObject() as Lang.Dictionary {
    return { A.B.a() => A.B.x, "x" => 42 };
}

function nonInline(x as Number) as Number {
    A.B.x++;
    x++;
    return x;
}

(:inline,:typecheck(false))
function unusedLogicals() as Number {
    return (
        (A.B.a() || 3) * (nonInline(A.B.x) || 4) +
        (A.B.x != 0 ? nonInline(1) : A.B.x) +
        (A.B.x != 0 && nonInline(1) != 0 ? 1 : 0) +
        (A.B.x == 0 || nonInline(1) != 0 ? 1 : 0)
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
    /* @match /^A.B.a\(\);/ /^nonInline/ /if \(A.B.x != @0\) \{.*?\}/ /if \(A.B.x != @0\) \{.*\}/ /if \(A.B.x == @0\) \{ \} else \{/ /^check/ */
    unusedLogicals();
    check(A.B.x, 7, logger);
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
            /* @match /^\$.z \+= 3;$/ */
            A.B.s2(3);
            check($.z, 3, logger);
        }
        return ok;
    }
}

function wrapper(x as Number) as Number {
    x++;
    return x - 1;
}

(:test) // foo
function inlineAssignContext(logger as Logger) as Boolean {
    var x;
    ok = true;
    A.B.x = 4;
    z = 3;
    var arr = [1, 2, 3] as Array<Number>;

    /* @match /x = @6;/ */
    x = assignContext(1);
    check(x, 6, logger);
    /* @match /x = @-42;/ */
    x = -(assignContext(z) + 1 == 13 ? 42 : 0);
    check(x, -42, logger);
    /* @match /\b(\w+x\w+) = (\1|arr)\.slice/ */
    x = assignContext3(arr)[2] + 1;
    check(x, 4, logger);
    z = wrapper(z);
    {
        var z = wrapper(15);
        /* @match /(self.z|pre_z(_\d+)?) \* / */
        x = assignContext(A.B.x);
        check(x, z, logger);
    }
    /* @match /^z \+= A.B.s3/ */
    z += A.B.s3(2);
    check(z, 8, logger);
    /* @match /z \+= @2/ */
    z = A.B.s3(2);
    check(z, 10, logger);

    /* @match "var a;" /z \+= @2;/ /a = z;/ */
    var a = A.B.s3(2);
    check(a, 12, logger);

    /* @match /var c;/ /z \+= @3/ "c = z;" "var d;" /\s+d =/ /^check/ */
    var b = 42,
        c = A.B.s3(3),
        d = -assignContext(1) + 1,
        e = 42;
    check(c, 15, logger);
    check(d, -29, logger);
    check(b - e, 0, logger);

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

    /* @match /^\{ var z = \$\.z; self.z\+\+;/ /check/ */
    x = argInterference1(A.B.x, A.x, $.z);
    check(x, A.B.x + A.x + $.z - 1, logger);

    /* @match /^\{ var y = A\.x; A.x\+\+;/ /check/ */
    x = argInterference2($.z, A.x, A.B.x);
    check(x, A.B.x + A.x + $.z - 1, logger);

    A.B.x += wrapper(0);
    /* @match /^\{ var z = A\.B\.x; A.B.a\(\);/ /check/ */
    x = argInterference3($.z, A.x, A.B.x);
    check(x, A.B.x + A.x + $.z - 1, logger);

    /* @match /z = A\.B\.x; var method/ /check/ */
    x = argInterference4($.z, A.x, A.B.x);
    check(x, A.B.x + A.x + $.z - 1, logger);
    return ok;
}

(:inline)
function ifContext1(x as Number) as Boolean {
    x++;
    return x == 2;
}

(:inline)
function ifContext2(x as Number) as Number {
    x++;
    return x;
}

(:test)
function inlineIfContext(logger as Logger) as Boolean {
    var x;
    ok = true;
    A.B.x = 4;

    /* @match /^\{ var pmcr_tmp.* var \w+x\w+ = wrapper\(1\);/ */
    if (ifContext1(wrapper(1))) {
    } else {
        logger.debug("Failed: ifContext1(1) should return true");
        ok = false;
    }
    if (A.B.x != 4) {
        logger.debug("Failed: A.B.x should be 4");
        ok = false;
    } /* @match /^\{ ((?!if.* else .*).)+z\+\+.*\}/ */ else if (ifContext1(2)) {
        logger.debug("Failed: ifContext1(2) should return false");
        ok = false;
    } else {
        z++;
    }

    /* @match /^\{ var pmcr_tmp.* var \w+x\w+ = wrapper\(@1\);/ */
    if (ifContext2(wrapper(1)) == 2) {
    } else {
        logger.debug("Failed: ifContext2(1) should return 2");
        ok = false;
    }

    /* @match /^\{ var pmcr_tmp.* var \w+x\w+ = wrapper\(@2\);/ */
    if (ifContext1(wrapper(2)) == true ? false : true) {
    } else {
        logger.debug("Failed: ifContext1(2) should return false");
        ok = false;
    }
    return ok;
}

import Toybox.Activity;

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

(:inline)
function assignContext3(x as Array<Number>) as Array<Number> {
    /* @match This should have been removed */
    x = x.slice(null, null);
    x[1]++;
    return x;
}

(:inline)
function argInterference1(x as Number, y as Number, z as Number) as Number {
    self.z++;
    return x + y + z;
}
(:inline)
function argInterference2(x as Number, y as Number, z as Number) as Number {
    A.x++;
    return x + y + z;
}

(:inline)
function argInterference3(x as Number, y as Number, z as Number) as Number {
    A.B.a();
    return x + y + z;
}

(:inline)
function argInterference4(x as Number, y as Number, z as Number) as Number {
    var method = new Lang.Method(A.B, :a) as (Method() as Void);
    method.invoke();
    return x + y + z;
}

(:inline,:typecheck(false))
function getConfigTry(
    key as Toybox.Application.PropertyKeyType
) as Toybox.Application.PropertyValueType {
    try {
        return OptimizerTestsApp.getProperty(key);
    } catch (e) {
        return null;
    }
}

(:inline,:typecheck(false))
function getConfigIf(
    key as Toybox.Application.PropertyKeyType
) as Toybox.Application.PropertyValueType {
    if (key != 42) {
        return OptimizerTestsApp.getProperty(key);
    }
    return null;
}

(:test)
function testInlineMultipleReturns(logger as Logger) as Boolean {
    // @expect "Function had more than one return statement"
    var x = getConfigTry("foo") as String;
    // @expect "Function had more than one return statement"
    var y = getConfigIf("foo") as String;
    return x == y;
}

(:inline)
function warningFromInlineC(z as Array<Number>?) as Boolean {
    if (z != null) {
        z[0]++;
    }
    return z != null;
}

(:inline)
function warningFromInlineB(y as Array<Number>?) as Boolean {
    if (y != null) {
        y[0]++;
    }
    return warningFromInlineC(y);
}

(:inline)
function warningFromInlineA(x as Array<Number>?) as Boolean {
    if (x != null) {
        x[0]++;
    }
    return warningFromInlineB(x);
}

(:test)
function testWarningsFromInline(logger as Logger) as Boolean {
    var a = null;
    if (logger != gLogger) {
        a = [1] as Array<Number>;
    }
    var x = warningFromInlineA(a);
    a = [1, 2, 3] as Array<Number>;
    var y = warningFromInlineA(a);
    return x && y;
}
