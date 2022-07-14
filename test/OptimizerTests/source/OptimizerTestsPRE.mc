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
