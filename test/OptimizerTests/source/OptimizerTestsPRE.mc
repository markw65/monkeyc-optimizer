import Toybox.Test;
import Toybox.Lang;
import Toybox.Graphics;

var FONT as Graphics.FontDefinition = Graphics.FONT_XTINY;

(:test)
function testSubstitution(logger as Logger) as Boolean {
    /* @match /var x = wrapper\(pre_/ */
    var x = wrapper(FONT);
    var y = wrapper(FONT);
    var z = wrapper(FONT);
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
    /* @match "checksArgs(pre_1, pre_1f, pre_1l, pre_1d)" */
    return (
        checksArgs(1, 1f, 1l, 1d) &&
        checksArgs(1, 1f, 1l, 1d) &&
        checksArgs(1, 1f, 1l, 1d)
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

    {
        var result2 = mResult;
        result2++;
        mResult = result2;
    }
    /* @match /\bresult2\b.*\bresult2\b/ */
    if (mResult != null) {
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
