import Toybox.Test;
import Toybox.Lang;
import Toybox.Graphics;

const FONT = Graphics.FONT_XTINY;

(:test)
function testSubstitution(logger as Logger) as Boolean {
    /* @match /var x = pre_/ */
    var x = FONT;
    var y = FONT;
    var z = FONT;
    return x == y && y == z;
}

function checksArgs(
    n as Number,
    f as Float,
    l as Long,
    d as Double
) as Boolean {
    return (
        n instanceof Lang.Number &&
        f instanceof Lang.Float &&
        l instanceof Lang.Long &&
        d instanceof Lang.Double &&
        n == f &&
        l == d &&
        f == l
    );
}

(:test)
function testFloatVsNumber(logger as Logger) as Boolean {
    /* @match /var n1 = pre_/ */
    var n1 = 1,
        n2 = 1,
        n3 = 1;
    /* @match /var f1 = pre_/ */
    var f1 = 1.0f,
        f2 = 1.0f,
        f3 = 1.0;
    /* @match /var l1 = pre_/ */
    var l1 = 1l,
        l2 = 1l,
        l3 = 1l;
    /* @match /var d1 = pre_/ */
    var d1 = 1.0d,
        d2 = 1.0d,
        d3 = 1.0d;
    return (
        n1 == n2 &&
        n2 == n3 &&
        f1 == f2 &&
        f2 == f3 &&
        l1 == l2 &&
        l2 == l3 &&
        d1 == d2 &&
        d2 == d3 &&
        checksArgs(n1, f1, l1, d1)
    );
}

var gMaybeModified as Number = 0;
function throwAndModify() as Exception {
    gMaybeModified++;
    throw new Lang.Exception();
}

(:test)
function testPREWithTry(logger as Logger) as Boolean {
    try {
        /* @match "if (gMaybeModified" */
        if (gMaybeModified != 0) {
            return false;
        }
        throwAndModify();
        return false;
    } catch (ex) {
        /* @match "if (pre_gMaybeModified" */
        if (gMaybeModified == 0) {
            return false;
        }
    }
    /* @match "return pre_gMaybeModified" */
    return gMaybeModified == 1;
}

function conflict() as Void {
    gMaybeModified++;
}

function safe() as Number {
    return gMaybeModified * 2;
}

// testing that PRE
//   - correctly identifies function callees even in
//     the presence of same-named locals
//   - correctly identifies functions with no side-effects
(:test)
function testPREWithFunctionConflict(logger as Logger) as Boolean {
    var /* @match "conflict = pre_gMaybe" */ conflict = gMaybeModified + 2,
        /* @match "safe = pre_gMaybe" */ safe = gMaybeModified + 1;
    conflict += safe();
    /* @match "safe += pre_gMaybe" */
    safe += gMaybeModified;
    /* @match "conflict += pre_gMaybe" */
    conflict += gMaybeModified;
    conflict();

    /* @match "== gMaybeModified * 2" */
    return conflict - safe == gMaybeModified * 2 - 1;
}

var mResult as Number = 42;
(:test)
function testPreFailure1(logger as Logger) as Boolean {
    var extHr = "x";

    var result2 = mResult;
    result2++;
    mResult = result2;

    /* @match "pre_mResult" */
    if (mResult != null) {
        /* @match "pre_mResult" */
        extHr += " " + mResult;
    }
    return extHr.equals("x 43");
}

(:test)
function testPreFailure2(logger as Logger) as Boolean {
    $.gMaybeModified = 0;
    conflict();
    if (mResult != 100) {
        $.gMaybeModified += 5;

        conflict();
        // PRE doesn't work for this example yet. For now,
        // check that it failed:
        // @match /(\b(?!pre_)gMaybeModified.*){2}/
        if ($.gMaybeModified < 0 || $.gMaybeModified > 100) {
            return false;
        }
    }

    return $.gMaybeModified == 7;
}
