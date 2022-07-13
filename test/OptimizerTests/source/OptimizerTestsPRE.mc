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

function checksArgs(n as Number, f as Float) as Boolean {
    return n instanceof Lang.Number && f instanceof Lang.Float && n == f;
}

(:test)
function testFloatVsNumber(logger as Logger) as Boolean {
    /* @match /var x = pre_/ */
    var x = 1;
    var y = 1;
    var z = 1;
    var u = 1.0,
        v = 1.0,
        w = 1.0;
    return x == y && y == z && u == v && v == w && checksArgs(x, u);
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
