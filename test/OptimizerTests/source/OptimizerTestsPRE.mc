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
    var conflict = gMaybeModified + 2,
        /* @match "safe = pre_gMaybe" */ safe = gMaybeModified + 1;
    /* @match "conflict = pre_gMaybe" */
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
    /* @match /\bpre_mResult\b.*\bpre_mResult\b/ */
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

function getArrayInitDict() as Lang.Dictionary<Number, Array<Array<Number> > > {
    return (
        ({
            // This triggered an array-init bug in the post build optimizer The key
            // 2 is on the stack when the 2 element array [3,4] is constructed via
            // `new [2]`. So an earlier optimization replaces the size of the array
            // with a dup of the key. But the array-init optimization didn't adjust
            // the dup's offset, so it ends up dup'ing the wrong element (as it
            // happens, the outer array), which triggers a type error when
            // constructing the inner array.
            //
            // the `5, 6, 7` are needed to trigger the array-init optimization (we
            // need at least 4 elements to get a win).
            2 => [[3, 4], [5], [6], [7]],
        }) as Lang.Dictionary<Number, Array<Array<Number> > >
    );
}

(:test)
function testPostBuildArrayInit(logger as Logger) as Boolean {
    ok = true;
    var arrayInitDict = getArrayInitDict();
    var inner = arrayInitDict[2];
    if (inner == null) {
        return false;
    }
    check(inner[0][0], 3, logger);
    check(inner[0][1], 4, logger);
    return ok;
}

const array_values = [
    0, 1, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144, 169, 196, 225, 256, 289,
    324, 361, 400, 441, 484, 529, 576, 625, 676, 729, 784, 841, 900, 961, 1024,
    1089, 1156, 1225, 1296, 1369, 1444, 1521, 1600, 1681, 1764, 1849, 1936,
    2025, 2116, 2209, 2304, 2401, 2500, 2601, 2704, 2809, 2916, 3025, 3136,
    3249, 3364, 3481, 3600, 3721, 3844, 3969, 4096, 4225, 4356, 4489, 4624,
    4761, 4900, 5041, 5184, 5329, 5476, 5625, 5776, 5929, 6084, 6241, 6400,
    6561, 6724, 6889, 7056, 7225, 7396, 7569, 7744, 7921, 8100, 8281, 8464,
    8649, 8836, 9025, 9216, 9409, 9604, 9801, 10000, 10201, 10404, 10609, 10816,
    11025, 11236, 11449, 11664, 11881, 12100, 12321, 12544, 12769, 12996, 13225,
    13456, 13689, 13924, 14161,
];

(:test)
function testPostBuildArrayInitStackOverflow(logger as Logger) as Boolean {
    for (var i = 0; i < array_values.size(); i++) {
        if (array_values[i] != i * i) {
            return false;
        }
    }
    return true;
}

function minimizeKeepAssignOp(x as Number) as Number {
    var y = x * x;
    y *= y;
    return y + y;
}

var minLocalsTestVal as Number = 2;
(:test)
function testVariableMinimization(logger as Logger) as Boolean {
    return minimizeKeepAssignOp(minLocalsTestVal) == 32;
}
