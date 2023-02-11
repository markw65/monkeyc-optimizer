import Toybox.Lang;
import Toybox.Math;
import Toybox.Test;

(:test)
function uninitializedBug(logger as Logger) as Boolean {
    var emptyIndex = null;
    for (var idx = 1; idx <= 2; idx++) {
        /*
         * There was a bug that caused copy prop to try
         * to propagate extAntId to the next line, but it
         * left the later use alone, causing the compiler
         * to fail to build (extAntId is uninitialized)
         */
        var extAntId = Math.rand();
        if (42 == extAntId) {
            emptyIndex = idx;
            break;
        } else if (emptyIndex == null && extAntId == 0) {
            emptyIndex = idx;
        }
    }
    return true;
}

function testPartiallyAnticipatedCopyPropLocals(
    x as Number,
    y as Number,
    z as Boolean
) as Number {
    var a = x + y;
    var b = x - y;
    if (z) {
        // @match "return x + y;"
        return a;
    }
    // @match "return x - y;"
    return b;
}

function testPartiallyAnticipatedCopyPropGlobals(
    y as Number,
    z as Boolean
) as Number {
    var a = A.B.x + y;
    var b = A.B.x - y;
    if (z) {
        // @match /return @A.B.x \+ y;/
        return a;
    }
    // @match /return @A.B.x - y;/
    return b;
}

function testPartiallyAnticipatedCopyPropFunction(
    y as Number,
    z as Boolean
) as Number {
    var a = wrapper(y);
    if (z) {
        // @match "return a"
        return a;
    }
    return -y;
}

function testPartiallyAnticipatedCopyPropEffectFreeFunction(
    y as Numeric,
    z as Boolean
) as Numeric {
    var a = Toybox.Math.sqrt(y);
    if (z) {
        // @match "return Toybox.Math.sqrt(y)"
        return a;
    }
    return -y;
}

function testAnticipatedCopyPropFunction(
    x as Number,
    y as Number,
    z as Boolean
) as Number {
    var a = wrapper(x);
    if (z) {
        y++;
    }
    // @match "return wrapper"
    return a + y;
}

function testConflictCopyPropFunction(
    n as Number,
    d as Lang.Dictionary<Number, Number>
) as Number? {
    // @match "var x = d.get(n);"
    var x = d.get(n);
    d.remove(n);
    // @match "return x;"
    return x;
}

function testChainedCopyProp() as Number {
    var x = safe();
    var y = x + 1;
    conflict();
    return y;
}

function testOperatorAssignmentCopyProp1() as Number {
    var x = safe();
    // @match "x = safe() + 42;"
    x += 42;
    conflict();
    return x;
}

function testOperatorAssignmentCopyProp2(x as Number) as Number {
    // @match "return x + 42;"
    x += 42;
    return x;
}

function writeArray(a as Array<Number>) as Void {
    a[1]++;
}
function testArrayCopyProp(a as Array<Number>) as Number {
    var y = a[1] + 1;
    writeArray(a);
    // @match "return y;"
    return y;
}

(:test)
function testCopyProp(logger as Logger) as Boolean {
    ok = true;
    var x;
    x = testPartiallyAnticipatedCopyPropLocals(5, 2, true);
    check(x, 7, logger);
    x = testPartiallyAnticipatedCopyPropLocals(5, 2, false);
    check(x, 3, logger);
    A.B.x = 5;
    x = testPartiallyAnticipatedCopyPropGlobals(2, true);
    check(x, 7, logger);
    x = testPartiallyAnticipatedCopyPropGlobals(2, false);
    check(x, 3, logger);
    x = testPartiallyAnticipatedCopyPropFunction(2, true);
    check(x, 2, logger);
    x = testPartiallyAnticipatedCopyPropFunction(2, false);
    check(x, -2, logger);
    x = testAnticipatedCopyPropFunction(3, 2, true);
    check(x, 6, logger);
    x = testAnticipatedCopyPropFunction(3, 2, false);
    check(x, 5, logger);
    x = testPartiallyAnticipatedCopyPropEffectFreeFunction(9, true);
    check(x, 3.0, logger);
    x = testPartiallyAnticipatedCopyPropEffectFreeFunction(2, false);
    check(x, -2, logger);
    x = testConflictCopyPropFunction(42, { 42 => 24 });
    check(x, 24, logger);
    gMaybeModified = 1;
    x = testChainedCopyProp();
    check(x, 3, logger);
    x = testOperatorAssignmentCopyProp1();
    check(x, 46, logger);
    x = testOperatorAssignmentCopyProp2(gMaybeModified);
    check(x, 45, logger);
    x = testArrayCopyProp([1, 2, 3] as Array<Number>);
    check(x, 3, logger);
    return ok;
}
