import Toybox.Lang;
import Toybox.Test;

class Comparer {
    function compare(a as Number, b as Number) as Number {
        return a < b ? 1 : a > b ? -1 : 0;
    }
}

(:test)
function testArrayCompare(logger as Logger) as Boolean {
    var a = [1, 2, 3];
    a.sort(new Comparer() as Lang.Comparator);
    for (var i = 1; i < a.size(); i++) {
        var diff = a[i - 1] - a[i];
        if (diff < 0) {
            logger.debug("Sort failed at index " + i);
            logger.debug("  a[i-1] = " + a[i - 1] + ", a[i] = " + a[i]);
            return false;
        }
    }
    return true;
}
