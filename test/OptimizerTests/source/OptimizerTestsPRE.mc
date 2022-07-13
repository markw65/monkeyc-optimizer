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
